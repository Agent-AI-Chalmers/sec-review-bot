import React from 'react'
import { api, parkedRuns, throwIfUnauthorized, type ParkedRun } from '../api.js'
import type { ListRunsResponseBody } from '../api-types.generated.js'
import { useRefresh, type RefreshState } from '../../../shared/refresh.js'

interface RunsData extends RefreshState {
  data: ListRunsResponseBody | undefined
  blocked: ParkedRun[]
  error: unknown
  auxiliaryError: unknown
}

/** Refresh the list and parked queue together while keeping their failures independent. */
export function useRunsData(query: string): RunsData {
  const [result, setResult] = React.useState<{
    query: string
    data: ListRunsResponseBody
  }>()
  const [failure, setFailure] = React.useState<{
    query: string
    error: unknown
  }>()
  // Only same-query refreshes may keep their previous rows and pagination.
  const data = result?.query === query ? result.data : undefined
  const error = failure?.query === query ? failure.error : undefined
  const [auxiliaryError, setAuxiliaryError] = React.useState<unknown>()
  // Runs coordination has stopped retrying on any axis. They are not part of the run list's
  // normal pagination, and an operator needs to see them before the list, so they load
  // separately and a failure here never hides the list itself.
  const [blocked, setBlocked] = React.useState<ParkedRun[]>([])
  const latestQuery = React.useRef(query)
  latestQuery.current = query
  const load = React.useCallback(async (): Promise<void> => {
    const requestedQuery = query
    setFailure(undefined)
    // The parked queue is a separate read, but it belongs to the same refresh cycle: keeping it
    // out here made refresh look successful while a newly parked run stayed invisible.
    const parkedRequest = parkedRuns()
      .then((blocks) => {
        if (latestQuery.current === requestedQuery) {
          setBlocked(blocks)
          setAuxiliaryError(undefined)
        }
      })
      .catch((value: unknown) => {
        if (latestQuery.current === requestedQuery) setAuxiliaryError(value)
        // The queue is an operator aid, not a precondition for reading runs.
      })
    try {
      const nextData = await api<ListRunsResponseBody>(
        `/runs?${requestedQuery}`
      )
      if (latestQuery.current === requestedQuery) {
        setResult({ query: requestedQuery, data: nextData })
      }
    } catch (value) {
      if (latestQuery.current === requestedQuery)
        setFailure({ query: requestedQuery, error: value })
    }
    await parkedRequest
  }, [query])
  const { refresh, refreshing, lastChecked } = useRefresh(load)
  // An expired session must reach the sign-in form even when the console still has data
  // to show: nothing will update until it is handled, and the refresh banner cannot say so.
  throwIfUnauthorized(auxiliaryError)
  throwIfUnauthorized(error)
  return {
    data,
    blocked,
    error,
    auxiliaryError,
    refresh,
    refreshing,
    lastChecked
  }
}
