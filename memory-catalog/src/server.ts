import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import openapiGlue from '@platformatic/fastify-openapi-glue'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'

import {
  ExtractionConflictError,
  MaintenanceControlConflictError,
  MaintenancePausedError,
  PostgresMemoryCatalogStore,
  MemoryTreeRevisionConflictError,
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

function specPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const built = path.join(moduleDirectory, 'openapi.yaml')
  if (existsSync(built)) return built
  return path.resolve(
    moduleDirectory,
    '..',
    '..',
    'contracts',
    'memory-catalog-api',
    'v1',
    'openapi.yaml',
  )
}

function errorStatusCode(error: unknown): number {
  if (
    error instanceof ExtractionConflictError ||
    error instanceof MaintenanceControlConflictError ||
    error instanceof MaintenancePausedError ||
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
  options: { store: MemoryCatalogStore; token: string },
): Promise<void> {
  const { store, token } = options
  await app.register(openapiGlue, {
    specification: specPath(),
    serviceHandlers: {
      health: () => ({ status: 'ok' }),
      registerExtraction: async (request: FastifyRequest) => ({
        ok: true,
        created: await store.registerExtraction(
          request.body as RequestBody<'registerExtraction'>,
        ),
      }),
      getExtraction: async (request: FastifyRequest, reply: FastifyReply) => {
        const extractionId = (request.params as PathParameters<'getExtraction'>)
          .extraction_id
        const record = await store.getExtraction(extractionId)
        if (record) return record
        return await reply.status(404).send({
          error: `Memory extraction not found: ${extractionId}`,
          code: 'NOT_FOUND',
        })
      },
      listExtractions: async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as QueryParameters<'listExtractions'>
        const limit = query.limit ? Number(query.limit) : 50
        if (limit > 100) {
          return await reply.status(400).send({
            error: 'Extraction list limit must not exceed 100.',
            code: 'INVALID_BODY',
          })
        }
        return await store.listExtractions(query.cursor, limit, {
          ...(query.source_workflow
            ? { sourceWorkflow: query.source_workflow }
            : {}),
          ...(query.source_run_id ? { sourceRunId: query.source_run_id } : {}),
          ...(query.has_observation
            ? { hasObservation: query.has_observation === 'true' }
            : {}),
        })
      },
      listObservations: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const query = request.query as QueryParameters<'listObservations'>
        const limit = query.limit ? Number(query.limit) : 50
        if (limit > 100) {
          return await reply.status(400).send({
            error: 'Observation list limit must not exceed 100.',
            code: 'INVALID_BODY',
          })
        }
        return await store.listObservations(query.cursor, limit, {
          ...(query.status ? { status: query.status } : {}),
          ...(query.consumed_revision
            ? { consumedRevision: Number(query.consumed_revision) }
            : {}),
        })
      },
      getObservationBacklog: async () => await store.getObservationBacklog(),
      getCatalogOverview: async (request: FastifyRequest) => {
        const query = request.query as QueryParameters<'getCatalogOverview'>
        return await store.getCatalogOverview(query.range ?? '30d')
      },
      getMaintenanceControl: async () => await store.getMaintenanceControl(),
      pauseMaintenance: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.changeMaintenanceControl(
          'paused',
          request.body as RequestBody<'pauseMaintenance'>,
        )
        if (result.created) void reply.status(201)
        return result
      },
      resumeMaintenance: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.changeMaintenanceControl(
          'enabled',
          request.body as RequestBody<'resumeMaintenance'>,
        )
        if (result.created) void reply.status(201)
        return result
      },
      getMaintenanceInput: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const limit = Number(
          (request.query as QueryParameters<'getMaintenanceInput'>).limit,
        )
        if (limit > 100) {
          return await reply.status(400).send({
            error: 'Maintenance input limit must not exceed 100.',
            code: 'INVALID_BODY',
          })
        }
        return { input: await store.getMaintenanceInput(limit) }
      },
      createMemoryTreeRevision: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const result = await store.createMemoryTreeRevision(
          request.body as RequestBody<'createMemoryTreeRevision'>,
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
        const result = await store.restoreMemoryTree(
          request.body as RequestBody<'restoreMemoryTree'>,
        )
        if (result.created) void reply.status(201)
        return result
      },
      getMemoryTree: async () => await store.getMemoryTree(),
      getMemoryTreeRevision: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const revision = Number(
          (request.params as PathParameters<'getMemoryTreeRevision'>).revision,
        )
        const record = await store.getMemoryTreeRevision(revision)
        if (record) return record
        return await reply.status(404).send({
          error: `Memory tree revision not found: ${revision}`,
          code: 'NOT_FOUND',
        })
      },
      listMemoryTreeRevisions: async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        const query =
          request.query as QueryParameters<'listMemoryTreeRevisions'>
        const beforeRevision = query.before_revision
          ? Number(query.before_revision)
          : undefined
        const limit = query.limit ? Number(query.limit) : 50
        if (limit > 100) {
          return await reply.status(400).send({
            error: 'Memory tree revision history limit must not exceed 100.',
            code: 'INVALID_BODY',
          })
        }
        return await store.listMemoryTreeRevisions(beforeRevision, limit)
      },
    },
    securityHandlers: {
      catalogToken: (request: FastifyRequest) => {
        if (!bearerTokenMatches(request.headers.authorization, token)) {
          throw Object.assign(new Error('Unauthorized'), {
            statusCode: 401,
            code: 'UNAUTHORIZED',
          })
        }
      },
    },
  })
}

export async function createApp(options: {
  store: MemoryCatalogStore
  token: string
}): Promise<FastifyInstance> {
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
            ? error instanceof MaintenancePausedError
              ? 'MAINTENANCE_PAUSED'
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
  const store = new PostgresMemoryCatalogStore(
    requiredEnv('MEMORY_CATALOG_DATABASE_URL'),
  )
  await store.initialize()
  const app = await createApp({
    store,
    token: requiredEnv('MEMORY_CATALOG_TOKEN'),
  })
  const host = process.env.MEMORY_CATALOG_HOST?.trim() || '127.0.0.1'
  await app.listen({ port, host })
  return {
    close: async () => {
      await app.close()
      await store.close()
    },
  }
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
