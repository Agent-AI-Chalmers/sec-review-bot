import type { ReviewRunWorkflow } from '../contracts.js'
import { decodeRunListCursor } from '../persistence/review-run-queries.js'
import { observePublicationStep, observeRun } from '../observability.js'
import type {
  ExecutionStatus,
  PreparationStatus,
  PublicationStatus,
  ReviewRunStore
} from '../persistence/review-run-store.js'
import type { OperationHandlers } from './route-handlers.js'
import type { PathParams } from './route-types.js'

type ListQueryOptions = NonNullable<
  Parameters<ReviewRunStore['listRunsPage']>[0]
>

function invalidQuery(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'INVALID_QUERY'
  })
}

function parseListQuery(url: URL): ListQueryOptions {
  const rawLimit = url.searchParams.get('limit')
  const options: ListQueryOptions = {
    limit: rawLimit === null ? 50 : Number(rawLimit)
  }
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null) {
    // The read model owns the cursor format; the handler only decides the status a bad one
    // gets, so it asks the same decoder the query will use instead of restating the shape.
    if (decodeRunListCursor(cursor) === null)
      throw invalidQuery('cursor must be a valid run list cursor.')
    options.cursor = cursor
  }
  const executionStatus = url.searchParams.get('execution_status')
  if (executionStatus !== null)
    options.execution_status = executionStatus as ExecutionStatus
  const publicationStatus = url.searchParams.get('publication_status')
  if (publicationStatus !== null)
    options.publication_status = publicationStatus as PublicationStatus
  const preparationStatus = url.searchParams.get('preparation_status')
  if (preparationStatus !== null)
    options.preparation_status = preparationStatus as PreparationStatus
  const sourcePlatform = url.searchParams.get('source_platform')
  if (sourcePlatform !== null)
    options.source_platform = sourcePlatform as ReviewRunStore['sourcePlatform']
  const workflow = url.searchParams.get('workflow')
  if (workflow !== null) options.workflow = workflow as ReviewRunWorkflow
  for (const name of ['from', 'to'] as const) {
    const value = url.searchParams.get(name)
    if (value !== null) {
      options[name] = new Date(Date.parse(value)).toISOString()
    }
  }
  return options
}

export function buildReadRouteHandlers({
  store,
  logReadinessFailure,
  logDroppedRunRow
}: {
  store: ReviewRunStore
  logReadinessFailure: (error: unknown) => void
  logDroppedRunRow: (dropped: { run_id: string; error: unknown }) => void
}): OperationHandlers {
  return {
    getHealth: async () => ({ status: 'ok' }),

    getReadiness: async (_request, reply) => {
      try {
        await store.checkReadiness()
        return { status: 'ok' }
      } catch (error) {
        logReadinessFailure(error)
        return reply.code(503).send({ status: 'unavailable' })
      }
    },

    listRuns: async (request) => {
      const url = new URL(request.url ?? '/', 'http://review-runs.local')
      const { runs, next_cursor, dropped } = await store.listRunsPage(
        parseListQuery(url)
      )
      const statistics = await store.getExecutionStatistics(
        runs.map((run) => run.run_id)
      )
      for (const droppedRow of dropped) logDroppedRunRow(droppedRow)
      return {
        runs: runs.map((run) =>
          observeRun(run, statistics.get(run.run_id) ?? null)
        ),
        next_cursor
      }
    },

    getRun: async (request, reply) => {
      const { runId } = request.params as PathParams<'getRun'>
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      const statistics = await store.getExecutionStatistics([run.run_id])
      return { run: observeRun(run, statistics.get(run.run_id) ?? null) }
    },

    listRunPublicationSteps: async (request, reply) => {
      const { runId } = request.params as PathParams<'listRunPublicationSteps'>
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      const steps = await store.listPublicationSteps(run.run_id)
      return {
        run_id: run.run_id,
        publication_steps: steps.map(observePublicationStep)
      }
    },

    listRunEvents: async (request, reply) => {
      const { runId } = request.params as PathParams<'listRunEvents'>
      if (!(await store.runExists(runId)))
        return reply.code(404).send({ error: 'run_not_found' })
      return { run_id: runId, events: await store.listEvents(runId) }
    }
  }
}
