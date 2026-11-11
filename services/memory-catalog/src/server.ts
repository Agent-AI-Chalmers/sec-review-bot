import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

import openapiGlue from '@platformatic/fastify-openapi-glue'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'

import {
  ExtractionConflictError,
  MemoryTreeAutomationConflictError,
  AutomationPausedError,
  PublicationAbandonedError,
  PostgresMemoryCatalogStore,
  MemoryTreeRevisionConflictError,
  type AuthenticatedMemoryTreeAutomationOperation,
  type AuthenticatedMemoryTreeRestoreOperation,
  type AuthenticatedMemoryTreeRevisionCreation,
  type MemoryCatalogStore,
} from './catalog-store.js'
import type {
  PathParameters,
  QueryParameters,
  RequestBody,
} from './route-types.js'
import { integerEnv } from './env.js'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function bearerTokenMatches(
  header: string | undefined,
  expected: string,
): boolean {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return false
  const actual = Buffer.from(header.slice(prefix.length))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

type CatalogRole = 'worker' | 'operator'

const operatorActor = {
  kind: 'service' as const,
  id: 'memory-catalog-operator',
}

function unauthorized(): Error {
  return Object.assign(new Error('Unauthorized'), {
    statusCode: 401,
    code: 'UNAUTHORIZED',
  })
}

function invalidBody(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'INVALID_BODY',
  })
}

function validateExtraction(input: RequestBody<'registerExtraction'>): void {
  const ids = input.observations.map((item) => item.observation_id)
  if (new Set(ids).size !== ids.length)
    throw invalidBody('Observation IDs must be unique within an extraction.')
}

// OpenAPI cannot relate decision ids to the consumed observation ids.
function validateMaintenanceReport(
  source: RequestBody<'createMemoryTreeRevision'>['source'],
): void {
  if (source.kind === 'manual') return
  const decided = source.maintenance_report.observation_decisions.map(
    (decision) => decision.observation_id,
  )
  const expected = source.kind === 'learning' ? source.observation_ids : []
  if (
    decided.length !== expected.length ||
    new Set(decided).size !== decided.length ||
    !expected.every((id) => decided.includes(id))
  )
    throw invalidBody(
      'maintenance_report must contain exactly one decision per consumed observation id.',
    )
  for (const decision of source.maintenance_report.observation_decisions)
    if (decision.action !== 'skipped' && decision.topics.length === 0)
      throw invalidBody(
        `maintenance_report decision ${decision.observation_id} must name edited topics.`,
      )
}

function specPath(): string {
  const moduleDirectory = import.meta.dirname
  const built = path.join(moduleDirectory, 'openapi.yaml')
  if (existsSync(built)) return built
  return path.resolve(
    moduleDirectory,
    '../../../contracts/memory-catalog-api/v1/openapi.yaml',
  )
}

function errorStatusCode(error: unknown): number {
  if (
    error instanceof ExtractionConflictError ||
    error instanceof MemoryTreeAutomationConflictError ||
    error instanceof AutomationPausedError ||
    error instanceof MemoryTreeRevisionConflictError
  )
    return 409
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode
  }
  return 500
}

export async function registerMemoryCatalogRoutes(
  app: FastifyInstance,
  options: {
    store: MemoryCatalogStore
    workerToken: string
    operatorToken: string
  },
): Promise<void> {
  const { store, workerToken, operatorToken } = options
  // OpenAPI Glue runs security handlers before service handlers. Keep the authenticated role
  // out of request bodies and attach it to the request object without mutating Fastify types.
  const authenticatedRoles = new WeakMap<FastifyRequest, CatalogRole>()
  const authenticate = (
    request: FastifyRequest,
    allowedRoles: readonly CatalogRole[],
  ): void => {
    const role = bearerTokenMatches(request.headers.authorization, workerToken)
      ? 'worker'
      : bearerTokenMatches(request.headers.authorization, operatorToken)
        ? 'operator'
        : undefined
    if (role === undefined || !allowedRoles.includes(role)) throw unauthorized()
    authenticatedRoles.set(request, role)
  }
  const authenticatedRevisionInput = (
    request: FastifyRequest,
  ): AuthenticatedMemoryTreeRevisionCreation => {
    const input = request.body as RequestBody<'createMemoryTreeRevision'>
    const requiresWorker =
      input.source.kind === 'learning' || input.source.kind === 'reorganization'
    if (
      (requiresWorker && authenticatedRoles.get(request) !== 'worker') ||
      (input.source.kind === 'manual' &&
        authenticatedRoles.get(request) !== 'operator')
    )
      throw unauthorized()
    validateMaintenanceReport(input.source)
    return input.source.kind === 'manual'
      ? { ...input, source: { ...input.source, actor: operatorActor } }
      : { ...input, source: input.source }
  }
  await app.register(openapiGlue, {
    specification: specPath(),
    serviceHandlers: {
      reserveExtractionPublication: async (request: FastifyRequest) => {
        const input =
          request.body as RequestBody<'reserveExtractionPublication'>
        validateExtraction(input.registration)
        return await store.reserveExtractionPublication(input)
      },
      confirmExtractionPublication: async (request: FastifyRequest) => {
        const input =
          request.body as RequestBody<'confirmExtractionPublication'>
        validateExtraction(input.registration)
        return await store.confirmExtractionPublication(input)
      },
      listExtractionPublications: async (request: FastifyRequest) => ({
        publications: await store.listExtractionPublications(
          (request.params as PathParameters<'listExtractionPublications'>)
            .extraction_id,
        ),
      }),
      abandonRevisionPublications: async (request: FastifyRequest) => ({
        publications: await store.abandonRevisionPublications(
          request.body as RequestBody<'abandonRevisionPublications'>,
        ),
      }),
      reserveRevisionPublication: async (request: FastifyRequest) =>
        await store.reserveRevisionPublication(
          authenticatedRevisionInput(request),
        ),
      confirmRevisionPublication: async (request: FastifyRequest) =>
        await store.confirmRevisionPublication(
          authenticatedRevisionInput(request),
        ),
      listRevisionPublications: async (request: FastifyRequest) => {
        const { kind, owner_id } =
          request.params as PathParameters<'listRevisionPublications'>
        if (
          ((kind === 'learning' || kind === 'reorganization') &&
            authenticatedRoles.get(request) !== 'worker') ||
          (kind === 'manual' && authenticatedRoles.get(request) !== 'operator')
        )
          throw unauthorized()
        return {
          publications: await store.listRevisionPublications(kind, owner_id),
        }
      },
      health: () => ({ status: 'ok' }),
      registerExtraction: async (request: FastifyRequest) => {
        const input = request.body as RequestBody<'registerExtraction'>
        validateExtraction(input)
        return { ok: true, created: await store.registerExtraction(input) }
      },
      getExtraction: async (request: FastifyRequest, reply: FastifyReply) => {
        const extractionId = (request.params as PathParameters<'getExtraction'>)
          .extraction_id
        const record = await store.queries.getExtraction(extractionId)
        if (record) return record
        return await reply.status(404).send({
          error: `Memory extraction not found: ${extractionId}`,
          code: 'NOT_FOUND',
        })
      },
      listExtractions: async (request: FastifyRequest) => {
        const query = request.query as QueryParameters<'listExtractions'>
        const limit = query.limit ? Number(query.limit) : 50
        return await store.queries.listExtractions(query.cursor, limit, {
          ...(query.source_workflow
            ? { sourceWorkflow: query.source_workflow }
            : {}),
          ...(query.source_run_id ? { sourceRunId: query.source_run_id } : {}),
          ...(query.has_observation
            ? { hasObservation: query.has_observation === 'true' }
            : {}),
        })
      },
      listObservations: async (request: FastifyRequest) => {
        const query = request.query as QueryParameters<'listObservations'>
        const limit = query.limit ? Number(query.limit) : 50
        return await store.queries.listObservations(query.cursor, limit, {
          ...(query.status ? { status: query.status } : {}),
          ...(query.consumed_revision
            ? { consumedRevision: Number(query.consumed_revision) }
            : {}),
        })
      },
      getObservationBacklog: async () =>
        await store.queries.getObservationBacklog(),
      getCatalogOverview: async (request: FastifyRequest) => {
        const query = request.query as QueryParameters<'getCatalogOverview'>
        return await store.queries.getCatalogOverview(query.range ?? '30d')
      },
      getMemoryTreeAutomation: async () =>
        await store.queries.getMemoryTreeAutomation(),
      pauseMemoryTreeAutomation: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.changeMemoryTreeAutomation('paused', {
          ...(request.body as RequestBody<'pauseMemoryTreeAutomation'>),
          actor: operatorActor,
        } satisfies AuthenticatedMemoryTreeAutomationOperation)
        if (result.created) void reply.status(201)
        return result
      },
      resumeMemoryTreeAutomation: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.changeMemoryTreeAutomation('enabled', {
          ...(request.body as RequestBody<'resumeMemoryTreeAutomation'>),
          actor: operatorActor,
        } satisfies AuthenticatedMemoryTreeAutomationOperation)
        if (result.created) void reply.status(201)
        return result
      },
      getLearningInput: async (request: FastifyRequest) => {
        const limit = Number(
          (request.query as QueryParameters<'getLearningInput'>).limit,
        )
        return { input: await store.getLearningInput(limit) }
      },
      createMemoryTreeRevision: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.createMemoryTreeRevision(
          authenticatedRevisionInput(request),
        )
        if (result.created) {
          void reply.header(
            'Location',
            `/v1/memory-tree/revisions/${result.revision}`,
          )
          void reply.status(201)
        }
        return result
      },
      restoreMemoryTree: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.restoreMemoryTree({
          ...(request.body as RequestBody<'restoreMemoryTree'>),
          actor: operatorActor,
        } satisfies AuthenticatedMemoryTreeRestoreOperation)
        if (result.created) void reply.status(201)
        return result
      },
      getMemoryTree: async () => await store.queries.getMemoryTree(),
      getMemoryTreeRevision: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const revision = Number(
          (request.params as PathParameters<'getMemoryTreeRevision'>).revision,
        )
        const record = await store.queries.getMemoryTreeRevision(revision)
        if (record) return record
        return await reply.status(404).send({
          error: `Memory tree revision not found: ${revision}`,
          code: 'NOT_FOUND',
        })
      },
      listMemoryTreeRevisions: async (request: FastifyRequest) => {
        const query =
          request.query as QueryParameters<'listMemoryTreeRevisions'>
        const beforeRevision = query.before_revision
          ? Number(query.before_revision)
          : undefined
        const limit = query.limit ? Number(query.limit) : 50
        return await store.queries.listMemoryTreeRevisions(
          beforeRevision,
          limit,
        )
      },
    },
    securityHandlers: {
      catalogToken: (request: FastifyRequest) => {
        authenticate(request, ['worker', 'operator'])
      },
      workerToken: (request: FastifyRequest) => {
        authenticate(request, ['worker'])
      },
      operatorToken: (request: FastifyRequest) => {
        authenticate(request, ['operator'])
      },
    },
  })
}

export async function createApp(options: {
  store: MemoryCatalogStore
  workerToken: string
  operatorToken: string
}): Promise<FastifyInstance> {
  if (options.workerToken === options.operatorToken)
    throw new Error('Worker and operator tokens must be distinct.')
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  })
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = errorStatusCode(error)
    const code =
      statusCode === 400
        ? 'INVALID_BODY'
        : statusCode === 401
          ? 'UNAUTHORIZED'
          : statusCode === 409
            ? error instanceof PublicationAbandonedError
              ? 'PUBLICATION_ABANDONED'
              : error instanceof AutomationPausedError
                ? 'AUTOMATION_PAUSED'
                : 'CONFLICT'
            : 'INTERNAL_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    void reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal server error' : message,
      code,
    })
  })
  await registerMemoryCatalogRoutes(app, options)
  return app
}

export async function startMemoryCatalogServer(): Promise<{
  close: () => Promise<void>
}> {
  const port = integerEnv('MEMORY_CATALOG_PORT', 8092, 1, 65_535)
  const connectionString = requiredEnv('MEMORY_CATALOG_DATABASE_URL')
  const workerToken = requiredEnv('MEMORY_CATALOG_WORKER_TOKEN')
  const operatorToken = requiredEnv('MEMORY_CATALOG_OPERATOR_TOKEN')
  const host = process.env.MEMORY_CATALOG_HOST?.trim() || '127.0.0.1'
  await using resources = new AsyncDisposableStack()
  const store = new PostgresMemoryCatalogStore(connectionString)
  resources.defer(() => store.close())
  await store.initialize()
  const app = await createApp({
    store,
    workerToken,
    operatorToken,
  })
  resources.defer(() => app.close())
  await app.listen({ port, host })
  const running = resources.move()
  return { close: () => running.disposeAsync() }
}

if (process.env.NODE_ENV !== 'test') {
  const running = await startMemoryCatalogServer()
  const shutdown = async (): Promise<void> => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}
