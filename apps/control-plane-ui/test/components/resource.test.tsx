import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { useResource } from '../../browser/shared/resource.js'

test('a newer resource reload aborts and supersedes the previous attempt', async () => {
  const first = Promise.withResolvers<string>()
  const second = Promise.withResolvers<string>()
  const signals: AbortSignal[] = []
  const load = vi
    .fn<(signal: AbortSignal) => Promise<string>>()
    .mockImplementationOnce((signal) => {
      signals.push(signal)
      return first.promise
    })
    .mockImplementationOnce((signal) => {
      signals.push(signal)
      return second.promise
    })
  const { result } = renderHook(() => useResource(load))

  let firstReload!: Promise<void>
  let secondReload!: Promise<void>
  act(() => {
    firstReload = result.current.reload()
    secondReload = result.current.reload()
  })
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]?.aborted).toBe(false)

  first.resolve('stale')
  second.resolve('current')
  await act(async () => {
    await Promise.all([firstReload, secondReload])
  })

  expect(result.current.data).toBe('current')
  expect(result.current.error).toBeUndefined()
  expect(result.current.loading).toBe(false)
})

test('a failed reload retains the latest successful resource value', async () => {
  const failure = new Error('unavailable')
  const load = vi
    .fn<(signal: AbortSignal) => Promise<string>>()
    .mockResolvedValueOnce('ready')
    .mockRejectedValueOnce(failure)
  const { result } = renderHook(() => useResource(load))

  await act(async () => {
    await result.current.reload()
  })
  expect(result.current.data).toBe('ready')

  await act(async () => {
    await result.current.reload()
  })
  await waitFor(() => expect(result.current.loading).toBe(false))

  expect(result.current.data).toBe('ready')
  expect(result.current.error).toBe(failure)
})
