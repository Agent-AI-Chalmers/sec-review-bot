import React from 'react'

import { isAbortError } from './api-client.js'

/** One remote resource, with the load policy this package applies to every query. */
export interface Resource<T> {
  /** The latest successful value. Retained while a reload is in flight. */
  data: T | undefined
  /** True until the first attempt settles, and again while a reload is in flight. */
  loading: boolean
  /** The failure of the latest attempt, cleared by the next success. */
  error: unknown
  /** Run the query again. Resolves when this attempt settles and never rejects. */
  reload(): Promise<void>
}

interface ResourceState<T> {
  data: T | undefined
  error: unknown
  loading: boolean
}

/**
 * Own one query's load, abort and staleness policy.
 *
 * Every surface that reads the BFF needs the same four rules: a new attempt aborts the
 * previous one, a response that arrives after a newer attempt started is discarded, the
 * loading flag covers the attempt, and a failure is kept for the renderer instead of being
 * thrown from a rejected promise. Writing them once means a caller declares only its
 * request, and a route decides how to present a failure once rather than once per
 * resource.
 *
 * The hook does not start a load by itself: the caller's scheduler owns when a query runs,
 * so a route that refreshes through `useRefresh` does not issue its queries twice.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>
): Resource<T> {
  const [state, setState] = React.useState<ResourceState<T>>({
    data: undefined,
    error: undefined,
    loading: true
  })
  const generation = React.useRef(0)
  const controller = React.useRef<AbortController | null>(null)
  const loadRef = React.useRef(load)
  loadRef.current = load

  React.useEffect(
    () => (): void => {
      controller.current?.abort()
    },
    []
  )

  const reload = React.useCallback(async (): Promise<void> => {
    const attempt = ++generation.current
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setState((previous) => ({ ...previous, loading: true }))
    try {
      const data = await loadRef.current(next.signal)
      if (attempt !== generation.current) return
      setState({ data, error: undefined, loading: false })
    } catch (error) {
      if (attempt !== generation.current || isAbortError(error)) return
      setState((previous) => ({ ...previous, error, loading: false }))
    }
  }, [])

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    reload
  }
}
