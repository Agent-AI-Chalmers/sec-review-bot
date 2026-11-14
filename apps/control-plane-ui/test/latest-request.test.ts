import assert from 'node:assert/strict'
import test from 'node:test'

import { LatestRequestGuard } from '../browser/shared/latest-request.js'

test('only the latest request may commit data, error, or loading state', async () => {
  const guard = new LatestRequestGuard()
  const state: {
    data?: string
    error?: unknown
    loading: boolean
  } = { loading: false }
  const run = (work: Promise<string>): Promise<void> => {
    const request = guard.begin()
    state.loading = true
    state.error = undefined
    return work
      .then((data) => {
        if (request.isCurrent()) state.data = data
      })
      .catch((error: unknown) => {
        if (request.isCurrent()) state.error = error
      })
      .finally(() => {
        if (request.isCurrent()) state.loading = false
      })
  }

  const staleData = Promise.withResolvers<string>()
  const currentData = Promise.withResolvers<string>()
  const staleDataCompletion = run(staleData.promise)
  const currentDataCompletion = run(currentData.promise)
  staleData.resolve('stale')
  await staleDataCompletion
  assert.deepStrictEqual(state, { loading: true, error: undefined })

  currentData.resolve('current')
  await currentDataCompletion
  assert.deepStrictEqual(state, {
    data: 'current',
    loading: false,
    error: undefined
  })

  const staleError = Promise.withResolvers<string>()
  const finalData = Promise.withResolvers<string>()
  const staleErrorCompletion = run(staleError.promise)
  const finalDataCompletion = run(finalData.promise)
  staleError.reject(new Error('stale failure'))
  await staleErrorCompletion
  assert.deepStrictEqual(state, {
    data: 'current',
    loading: true,
    error: undefined
  })

  finalData.resolve('final')
  await finalDataCompletion
  assert.deepStrictEqual(state, {
    data: 'final',
    loading: false,
    error: undefined
  })
})
