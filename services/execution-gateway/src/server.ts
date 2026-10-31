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
  supportedWorkflows,
  validateExecutionInput,
} from './execution-api-validation.js'
import { ExecutionRunConflictError, type ExecutionRecord } from './execution.js'
import type { PathParameters, RequestBody } from './route-types.js'
import { integerEnv } from './env.js'
import {
  executionError,
  TemporalExecutionStore,
} from './temporal-execution-store.js'

function specPath(): string {
  const moduleDirectory = import.meta.dirname
  const built = path.join(moduleDirectory, 'openapi.yaml')
  if (existsSync(built)) return built
  return path.resolve(
    moduleDirectory,
    '../../../contracts/execution-api/v1/openapi.yaml',
  )
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice('Bearer '.length))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function response(record: ExecutionRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  )
}

function semanticError(
  code: string,
  category: string,
  message: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return { category, code, message, retryable: false, details }
}

export async function registerExecutionGatewayRoutes(
  app: FastifyInstance,
  options: {
    store: Pick<TemporalExecutionStore, 'start' | 'get'>
    token?: string
  },
): Promise<void> {
  const { store, token } = options
  const workflowTimeoutSeconds = integerEnv(
    'TEMPORAL_WORKFLOW_TIMEOUT_SECONDS',
    10_800,
  )
  await app.register(openapiGlue, {
    specification: specPath(),
    serviceHandlers: {
      health: () => ({ status: 'ok' }),
      createRun: async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RequestBody<'createRun'>
        const { workflow } = request.params as PathParameters<'createRun'>
        if (!supportedWorkflows().includes(workflow)) {
          return await reply.status(400).send({
            run_id: body.run_id,
            workflow,
            error: semanticError(
              'EXECUTION_WORKFLOW_UNSUPPORTED',
              'workflow',
              `Unsupported workflow: ${workflow}`,
            ),
          })
        }
        try {
          validateExecutionInput(workflow, body.input)
        } catch (error) {
          return await reply.status(400).send({
            run_id: body.run_id,
            workflow,
            error: semanticError(
              'EXECUTION_REQUEST_INVALID',
              'input',
              error instanceof Error ? error.message : String(error),
            ),
          })
        }
        try {
          return await reply.status(202).send(
            response(
              await store.start({
                workflow,
                run_id: body.run_id,
                input: body.input,
                timeout_seconds: workflowTimeoutSeconds,
                ...('runtime' in body ? { runtime: body.runtime } : {}),
              }),
            ),
          )
        } catch (error) {
          if (error instanceof ExecutionRunConflictError) {
            return await reply.status(409).send({
              run_id: error.runId,
              workflow: error.requestedWorkflow,
              error: semanticError(
                'EXECUTION_RUN_CONFLICT',
                'input',
                error.message,
                { existing_workflow: error.existingWorkflow ?? null },
              ),
            })
          }
          throw error
        }
      },
      getRun: async (request: FastifyRequest, reply: FastifyReply) => {
        const { run_id: runId } = request.params as PathParameters<'getRun'>
        const record = await store.get(runId)
        if (record) return response(record)
        return await reply.status(404).send({
          run_id: runId,
          error: semanticError(
            'EXECUTION_RUN_NOT_FOUND',
            'runtime',
            'Execution run not found.',
          ),
        })
      },
      getRunStatuses: async (request: FastifyRequest) => {
        const body = request.body as RequestBody<'getRunStatuses'>
        const records = await Promise.all(
          [...new Set(body.run_ids)].map(
            async (runId) => [runId, await store.get(runId)] as const,
          ),
        )
        return {
          runs: records
            .filter(
              (entry): entry is readonly [string, ExecutionRecord] =>
                entry[1] !== undefined,
            )
            .map(([runId, record]) => ({
              run_id: runId,
              status: record.status,
            })),
          missing: records
            .filter(([, record]) => !record)
            .map(([runId]) => runId),
        }
      },
    },
    securityHandlers: {
      HTTPBearer: (request: FastifyRequest) => {
        if (token && !tokenMatches(request.headers.authorization, token)) {
          throw Object.assign(
            new Error('Missing or invalid execution gateway token.'),
            {
              statusCode: 401,
            },
          )
        }
      },
    },
  })
}

export async function createApp(options: {
  store: Pick<TemporalExecutionStore, 'start' | 'get'>
  token?: string
}): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  })
  app.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
    const message = error instanceof Error ? error.message : String(error)
    void reply.status(statusCode).send({
      error: executionError(
        statusCode === 401 ? 'UNAUTHORIZED' : 'EXECUTION_FAILED',
        statusCode === 500 ? 'Internal server error.' : message,
      ),
    })
  })
  await registerExecutionGatewayRoutes(app, options)
  return app
}

export async function startExecutionGateway(): Promise<{
  close(): Promise<void>
}> {
  const port = integerEnv('EXECUTION_GATEWAY_PORT', 8000, 1, 65_535)
  const store = await TemporalExecutionStore.connect()
  const token = process.env.EXECUTION_GATEWAY_TOKEN?.trim()
  const host = process.env.EXECUTION_GATEWAY_HOST?.trim() || '127.0.0.1'
  if (
    !token &&
    host !== '127.0.0.1' &&
    host !== 'localhost' &&
    host !== '::1'
  ) {
    throw new Error(
      'EXECUTION_GATEWAY_TOKEN is required for a non-loopback host.',
    )
  }
  const app = await createApp({ store, ...(token ? { token } : {}) })
  await app.listen({
    host,
    port,
  })
  return {
    close: async () => {
      await app.close()
      await store.close()
    },
  }
}

if (process.env.NODE_ENV !== 'test') {
  const running = await startExecutionGateway()
  const shutdown = async (): Promise<void> => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}
