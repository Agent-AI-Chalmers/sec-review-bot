import React from 'react'
import { api, type PublicationStep, type Run, type RunEvent } from '../api.js'
import type {
  GetRunResponseBody,
  ListRunPublicationStepsResponseBody,
  ListRunEventsResponseBody
} from '../api-types.generated.js'
import { isRunTerminal } from '../format.js'
import { useRefresh } from '../../../shared/refresh.js'

interface RunDetailData {
  run: Run | undefined
  steps: PublicationStep[]
  events: RunEvent[]
  error: unknown
  load: () => Promise<void>
  terminal: boolean
}

/** Load a run and its related records together; keep route changes isolated by run ID. */
export function useRunDetail(runId: string): RunDetailData {
  // Both are keyed by run id. React Router keeps this component mounted when only the
  // id changes, so unkeyed state would keep rendering the previous run — and a 404 for
  // the new id would then be reported as a failed refresh of the old one.
  const [loaded, setLoaded] = React.useState<{
    runId: string
    run: Run
    steps: PublicationStep[]
    events: RunEvent[]
  }>()
  const [failure, setFailure] = React.useState<{
    runId: string
    error: unknown
  }>()
  const run = loaded?.runId === runId ? loaded.run : undefined
  const steps = loaded?.runId === runId ? loaded.steps : []
  const events = loaded?.runId === runId ? loaded.events : []
  const error = failure?.runId === runId ? failure.error : undefined
  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [runValue, stepValue, eventValue] = await Promise.all([
        api<GetRunResponseBody>(`/runs/${encodeURIComponent(runId)}`),
        api<ListRunPublicationStepsResponseBody>(
          `/runs/${encodeURIComponent(runId)}/publication-steps`
        ),
        api<ListRunEventsResponseBody>(
          `/runs/${encodeURIComponent(runId)}/events`
        )
      ])
      setLoaded({
        runId,
        run: runValue.run,
        steps: stepValue.publication_steps,
        events: eventValue.events
      })
      setFailure(undefined)
    } catch (value) {
      setFailure({ runId, error: value })
    }
  }, [runId])
  const terminal = run ? isRunTerminal(run) : false
  // Polls while the run is active. The detail page renders no refresh chrome, so
  // the hook's display state (refreshing / lastChecked) is intentionally unused.
  useRefresh(load, !terminal)
  return { run, steps, events, error, load, terminal }
}
