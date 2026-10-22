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
  ObservationConflictError,
  PostgresMemoryCatalogStore,
  type MemoryCatalogStore,
} from './catalog-store.js'
import type {
  PathParameters,
  QueryParameters,
  RequestBody,
} from './route-types.js'

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
    'openapi.yaml',
  )
}

function errorStatusCode(error: unknown): number {
  if (error instanceof ObservationConflictError) return 409
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
      registerObservation: async (request: FastifyRequest) => ({
        ok: true,
        created: await store.registerObservation(
          request.body as RequestBody<'registerObservation'>,
        ),
      }),
      pendingObservationSummary: async () =>
        await store.pendingObservationSummary(),
      selectMaintenanceBatch: async (request: FastifyRequest) => ({
        batch: await store.selectMaintenanceBatch(
          (request.body as RequestBody<'selectMaintenanceBatch'>).limit,
        ),
      }),
      completeMaintenance: async (request: FastifyRequest) => ({
        completed: await store.completeMaintenance(
          request.body as RequestBody<'completeMaintenance'>,
        ),
      }),
      activeVersion: async () => await store.activeVersion(),
      getRevision: async (request: FastifyRequest, reply: FastifyReply) => {
        const revision = Number(
          (request.params as PathParameters<'getRevision'>).revision,
        )
        const record = await store.getRevision(revision)
        if (record) return record
        return await reply.status(404).send({
          error: `Memory revision not found: ${revision}`,
          code: 'NOT_FOUND',
        })
      },
      listRevisions: async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as QueryParameters<'listRevisions'>
        const beforeRevision = query.before_revision
          ? Number(query.before_revision)
          : undefined
        const limit = query.limit ? Number(query.limit) : 50
        if (limit > 100) {
          return await reply.status(400).send({
            error: 'Revision history limit must not exceed 100.',
            code: 'INVALID_BODY',
          })
        }
        return await store.listRevisions(beforeRevision, limit)
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
            ? 'CONFLICT'
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
  const store = new PostgresMemoryCatalogStore(
    requiredEnv('MEMORY_CATALOG_DATABASE_URL'),
  )
  await store.initialize()
  const app = await createApp({
    store,
    token: requiredEnv('MEMORY_CATALOG_TOKEN'),
  })
  const port = Number.parseInt(process.env.MEMORY_CATALOG_PORT ?? '8092', 10)
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
