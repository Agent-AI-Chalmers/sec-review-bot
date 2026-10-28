// Builds the authenticated Review Runs HTTP surface from the OpenAPI contract
// and connects transport operations to the durable coordination store.
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import openapiGlue from '@platformatic/fastify-openapi-glue'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { buildAdminRouteHandlers } from './admin-route-handlers.js'
import { contractDigest } from '../contract-digest.js'
import { buildCoordinationRouteHandlers } from './coordination-route-handlers.js'
import { ReviewRunStore } from '../persistence/review-run-store.js'
import { buildReadRouteHandlers } from './read-route-handlers.js'
import { DeterministicReviewRunError } from '../errors.js'
import { ERROR_RESPONSE_CODES_FROM_CONTRACT } from '../error-codes-generated.js'
import type { OperationHandlers } from './route-handlers.js'

const MAX_BODY_BYTES = 1024 * 1024

/** Fastify options shared by the server and its tests.
 *
 * `removeAdditional: false` makes the contract's `additionalProperties: false` mean what it
 * says — a request with an undeclared field is rejected, rather than having the field silently
 * stripped (Fastify's ajv default), which would make the contract overstate the validation.
 *
 * `coerceTypes: false` makes every declared type mean literally what it says, which the default
 * (`true`) does not: a JSON body is already typed by its parser, so coercion only ever *loosens*
 * a body there. With coercion on, `remote_object.id` (declared `[string, "null"]`) accepted
 * `true` as `"true"` and `1234` as `"1234"` — values the contract never declared. Bodies must
 * therefore be validated without coercion.
 *
 * The query string is the one place coercion is genuinely needed, because a URL can only carry
 * `limit=10` and the contract declares `limit` an `integer`. Rather than re-enable coercion for
 * every body, `coerceQueryStrings` restores it for the query alone, driven by each route's own
 * contract-derived schema — so the query still validates as declared and no body is loosened.
 *
 * `allowUnionTypes` is a guard rather than a current need: ajv's strict-types check warns on a
 * non-nullable `type` array, and no request schema declares one today (`remote_object.id` is
 * `[string, "null"]`, which ajv accepts). It is set so that adding such a union later fails
 * *validation* rather than silently emitting a warning nobody reads. */
export const REVIEW_RUNS_FASTIFY_OPTIONS = {
  bodyLimit: MAX_BODY_BYTES,
  ajv: {
    customOptions: {
      removeAdditional: false,
      coerceTypes: false,
      allowUnionTypes: true
    }
  }
} as const

/** The scalar JSON types the query string can declare, and how a raw string becomes one. */
type QueryScalarType = 'integer' | 'number' | 'boolean'

/**
 * Coerce the query string to the types the route's own schema declares.
 *
 * The query string is always strings, so a contract that says `limit: { type: integer }` can
 * only be satisfied by coercion; ajv does that when `coerceTypes` is on, but turning it on
 * globally would also loosen every JSON body (see `REVIEW_RUNS_FASTIFY_OPTIONS`). This hook
 * runs before schema validation and coerces only the properties the route declares, read from
 * `request.routeOptions.schema.querystring` — the schema fastify-openapi-glue built from the
 * contract — so it duplicates no knowledge and stays in step with the document. A value that
 * does not parse is left untouched and rejected by the schema, not guessed at.
 */
function coerceQueryStrings(request: FastifyRequest): void {
  const querystring = (
    request.routeOptions?.schema as { querystring?: unknown } | undefined
  )?.querystring
  const properties = (
    querystring as
      { properties?: Record<string, { type?: QueryScalarType }> } | undefined
  )?.properties
  if (properties === undefined) return
  const query = request.query as Record<string, unknown> | null
  if (query === null || typeof query !== 'object') return
  for (const [name, value] of Object.entries(query)) {
    if (typeof value !== 'string') continue
    const type = properties[name]?.type
    if (type === 'integer' || type === 'number') {
      const parsed = Number(value)
      if (value.trim() !== '' && Number.isFinite(parsed)) query[name] = parsed
    } else if (type === 'boolean') {
      if (value === 'true') query[name] = true
      else if (value === 'false') query[name] = false
    }
  }
}
// Statuses whose handling needs the run record itself, because the terminal writes
// persist the result, the error, and the artifact reference. Every other status is
// answered from the pass's batch, so a poll where nothing changed costs one request
// rather than one per run.
// The list-query filter values are constrained by the contract's query schema (glue mounts it
// on the route), so there is no enumeration to restate here.
// The error-envelope `code` values. `INVALID_QUERY` is the run-list query filter; the four
// `PUBLICATION_STEP_*` codes also surface here, carried by the REST write routes for
// deterministic publication failures the client must classify as terminal.
// The closed set of `code` values the envelope may carry, projected from the contract's
// ErrorResponse.code enum so the surface cannot advertise a code the contract omits. Typed as
// string[] because the membership check guards an arbitrary thrown error's `code`.
const errorCodeEnum: readonly string[] = [...ERROR_RESPONSE_CODES_FROM_CONTRACT]
function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // Keep operational logs structured, but never serialize request arguments:
  // they may contain execution input, publish context, or claim credentials.
  console.info(JSON.stringify({ event, ...fields }))
}

/** Report a stored row the contract cannot represent, with the identity and fault needed to
 * find it. The reads that can hit one skip and report it rather than failing the whole read,
 * so this is the only record that the row was dropped. */
function logDroppedRunRow(
  connectorId: string,
  dropped: { run_id: string; error: unknown }
): void {
  logEvent('review_runs_run_row_dropped', {
    connector_id: connectorId,
    run_id: dropped.run_id,
    error:
      dropped.error instanceof Error
        ? dropped.error.message
        : String(dropped.error)
  })
}

/** Compare a bearer credential in constant time.
 *
 * The equality check runs for every request, so `!==` would let an attacker recover a token
 * byte by byte from the response-time difference. `timingSafeEqual` throws when the buffers
 * differ in length, which is why the length is compared first: the length of the expected
 * token is not the secret, and a mismatch is a plain rejection. */
function bearerTokenMatches(
  header: string | undefined,
  expected: string
): boolean {
  if (header === undefined) return false
  const provided = Buffer.from(header)
  const want = Buffer.from(`Bearer ${expected}`)
  return provided.length === want.length && timingSafeEqual(provided, want)
}

interface ReviewRunsRouteDeps {
  store: ReviewRunStore
  serviceToken: string
  readToken: string
  /** Optional operator credential. When absent the whole `/v1/admin` surface answers 404, so an
   * unconfigured deployment exposes no admin route at all rather than an unauthenticated one. */
  adminToken?: string
}

/** Locate the OpenAPI contract relative to this module, not the process CWD.
 *
 * fastify-openapi-glue resolves a relative `specification` against the CWD, which breaks as
 * soon as the server runs from a different directory (notably the container, where only
 * `dist/` is present). The build copies the contract next to the compiled output (`copy:spec`)
 * together with its SHA-256, so the compiled server finds it first and can prove it is the one
 * that build produced — a stale or hand-edited copy beside `server.js` fails loudly instead of
 * silently shaping the surface. Running from source (tsx) falls back to the repository's
 * contracts tree, which is the source of truth in that mode. */
function resolveSpecPath(): string {
  const built = path.resolve(import.meta.dirname, '../openapi.yaml')
  if (existsSync(built)) {
    const digestPath = `${built}.sha256`
    if (!existsSync(digestPath)) {
      throw new Error(
        `${built} has no ${digestPath}; the build must produce both.`
      )
    }
    const expected = readFileSync(digestPath, 'utf8').trim()
    const actual = contractDigest(readFileSync(built))
    if (actual !== expected) {
      throw new Error(
        `${built} does not match its recorded digest; rebuild so the contract and ` +
          'server.js come from the same build.'
      )
    }
    return built
  }
  const fromSource = path.resolve(
    import.meta.dirname,
    '../../../contracts/review-runs-api/v1/openapi.yaml'
  )
  if (existsSync(fromSource)) return fromSource
  throw new Error(
    `OpenAPI contract not found next to the module (${built}) or in the ` +
      `repository tree (${fromSource}).`
  )
}

/** Register Review Runs HTTP surface from the OpenAPI contract. Routes, request/response
 * schemas, and security all come from `contracts/review-runs-api/v1/openapi.yaml` via
 * fastify-openapi-glue; the handlers below only carry the domain logic against the store.
 * Kept separate from `startReviewRunsServer` so the routes can be registered with a stub
 * store (for tests) without a database.
 */
export async function registerReviewRunsRoutes(
  app: FastifyInstance,
  deps: ReviewRunsRouteDeps
): Promise<void> {
  const { store, serviceToken, readToken, adminToken } = deps

  // Errors propagate to the Fastify error handler, which maps a DeterministicReviewRunError
  // to 409 + code and keeps every other fault a message-free 500; handlers stay domain-only.

  // The handlers, keyed by operationId. Each handler calls the store directly and does only
  // the domain logic: routing, body/query/path validation, and auth come from the OpenAPI
  // spec via fastify-openapi-glue, so nothing here re-states a schema. Each handler's body
  // and params types come from its own operation in the contract (`route-types.ts`), so a
  // field renamed in `openapi.yaml` breaks the handler that reads it at compile time.
  const handlers: OperationHandlers = {
    ...buildReadRouteHandlers({
      store,
      logReadinessFailure: (error) =>
        logEvent('review_runs_readiness_failed', {
          connector_id: store.connectorId,
          message: error instanceof Error ? error.message : String(error)
        }),
      logDroppedRunRow: (dropped) =>
        logDroppedRunRow(store.connectorId, dropped)
    }),
    ...buildCoordinationRouteHandlers(store),
    ...buildAdminRouteHandlers(store)
  }

  // Error/not-found handlers belong to this HTTP surface, so they are registered here (and
  // before fastify-openapi-glue registers its child scope) rather than in
  // startReviewRunsServer: otherwise handler-thrown errors would get Fastify's default
  // envelope, and the surface could not be exercised without a database.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' })
  })

  app.setErrorHandler((error, request, reply) => {
    // A deterministic publication failure is a state conflict, not an internal fault: it
    // returns 409 with its PUBLICATION_STEP_* code so the client can classify it as terminal.
    // Handling it here (rather than per-handler) keeps every store method that can throw it
    // covered, including ones added later.
    if (error instanceof DeterministicReviewRunError) {
      return reply.code(409).send({ error: error.message, code: error.code })
    }
    // fastify-openapi-glue reports a failed authentication as a `SecurityError` whose message
    // names the security scheme ("None of the security schemes (readToken) successfully
    // authenticated this request."). Replace it with the surface's own envelope: the scheme
    // name is not the caller's business, and every other error here is `{ error }`. The
    // status stays 401, which the contract declares for these routes.
    if (error instanceof Error && error.name === 'Unauthorized') {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const errorCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null
    // Defense in depth: a Postgres datetime parse error (22007/22008) can only
    // originate from a bad `from`/`to` filter.
    if (errorCode === '22007' || errorCode === '22008') {
      return reply
        .code(400)
        .send({ error: 'from/to must be a valid date.', code: 'INVALID_QUERY' })
    }
    if (errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Request body is too large.' })
    }
    if (errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      // A body that is not JSON at all is still a bad body, so it carries the same
      // `INVALID_BODY` code the contract promises every 400 names which part with — rather
      // than a code-less 400, which the contract's `InvalidRequest` description would
      // overstate.
      return reply.code(400).send({
        error: 'Request body must be valid JSON.',
        code: 'INVALID_BODY'
      })
    }
    // A request rejected by the contract's own schema (glue mounts it as the route's query,
    // body, and params schema) names which part failed, so a caller classifying by `code`
    // can tell a bad filter from a bad body from a bad path parameter.
    if (errorCode === 'FST_ERR_VALIDATION') {
      const detail = error instanceof Error ? error.message : String(error)
      const context =
        typeof error === 'object' &&
        error !== null &&
        'validationContext' in error
          ? (error as { validationContext?: string }).validationContext
          : undefined
      const code =
        context === 'body'
          ? 'INVALID_BODY'
          : context === 'params'
            ? 'INVALID_PATH_PARAMETER'
            : 'INVALID_QUERY'
      return reply.code(400).send({ error: detail, code })
    }
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
    // Only surface codes in the closed set; internal codes (e.g. Postgres SQLSTATE)
    // must not leak into the envelope, which would also break the OpenAPI enum.
    const code =
      errorCode !== null && errorCodeEnum.includes(errorCode)
        ? errorCode
        : undefined
    // An unexpected internal fault (5xx) must not leak its message (which may carry SQLSTATE
    // or connection details); the caller only learns that the request failed. Known 4xx
    // results keep their message, since those are the caller's own input being rejected.
    if (status >= 500) {
      // A 5xx is a defect, not caller input, so it has to be diagnosable operationally even
      // though the response is deliberately opaque — a corrupt stored row (for example an
      // `available` artifact without its reference) otherwise surfaces only as a bare
      // "Internal error" with nothing naming the run. Log the identity and the error, never
      // request arguments, which may carry claim credentials.
      const runId = (request.params as { runId?: string } | undefined)?.runId
      console.error(
        JSON.stringify({
          event: 'review_runs_request_failed',
          method: request.method,
          url: request.url,
          ...(runId === undefined ? {} : { run_id: runId }),
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        })
      )
    }
    const message =
      status >= 500
        ? 'Internal error'
        : error instanceof Error
          ? error.message
          : String(error)
    return reply.code(status).send({
      error: message,
      ...(code === undefined ? {} : { code })
    })
  })

  // Runs before the route's own schema (Fastify order: preValidation, then validation), and the
  // hook is inherited by the child scope fastify-openapi-glue registers its routes in. Registered
  // here, on this HTTP surface, so it applies to (and only to) the contract's routes.
  // An unconfigured deployment must not expose an admin surface, not even as a 401. The security
  // handler alone cannot express that: fastify-openapi-glue wraps any failure there into its own
  // 401 `SecurityError`, so answering 404 from the handler still advertises the route. This hook
  // runs before routing settles on the glue's handler, so the path simply does not exist.
  app.addHook('onRequest', async (request, reply) => {
    if (adminToken === undefined && request.url.startsWith('/v1/admin')) {
      return reply.code(404).send({ error: 'not_found' })
    }
  })

  app.addHook('preValidation', async (request) => {
    coerceQueryStrings(request)
  })

  await app.register(openapiGlue, {
    specification: resolveSpecPath(),
    operationResolver: (operationId) => {
      const handler = handlers[operationId]
      if (handler === undefined) {
        throw new Error(`No handler registered for operation ${operationId}`)
      }
      // Log the state-changing operations with their identity (the README promises
      // durable-operation logs carrying connector_id and run_id). Reads — the health probe and
      // the GET queries — are deliberately not logged: they carry no durable effect and would
      // only dilute the audit signal. Wrapping here means a new operation is logged without
      // repeating the call. Only identifiers are logged, never request arguments, which may
      // carry claim credentials.
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const durable = request.method !== 'GET'
        const runId = (request.params as { runId?: string }).runId
        if (durable) {
          logEvent('review_runs_operation_started', {
            operation: operationId,
            ...(runId === undefined ? {} : { run_id: runId }),
            connector_id: store.connectorId
          })
        }
        const result = await handler(request, reply)
        if (durable) {
          logEvent('review_runs_operation_completed', {
            operation: operationId,
            ...(runId === undefined ? {} : { run_id: runId }),
            connector_id: store.connectorId
          })
        }
        return result
      }
    },
    securityHandlers: {
      serviceToken: async (request: FastifyRequest) => {
        if (!bearerTokenMatches(request.headers.authorization, serviceToken)) {
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
        }
      },
      readToken: async (request: FastifyRequest) => {
        if (!bearerTokenMatches(request.headers.authorization, readToken)) {
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
        }
      },
      adminToken: async (request: FastifyRequest) => {
        // With no configured token the routes must not exist: answering 401 would advertise an
        // operator surface this deployment deliberately does not have. A missing credential is
        // still unauthorized, so a configured deployment does not leak by status code either.
        if (adminToken === undefined) {
          throw Object.assign(new Error('not found'), { statusCode: 404 })
        }
        if (!bearerTokenMatches(request.headers.authorization, adminToken)) {
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
        }
      }
    }
  })
}
