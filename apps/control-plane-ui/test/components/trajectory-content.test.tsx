import React from 'react'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { TrajectoryContent } from '../../browser/features/trajectory/TrajectoryContent.js'
import { renderComponent } from './render.js'

function deferredResponse(): {
  promise: Promise<Response>
  resolve(value: Response): void
} {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function trajectoryResponse(content: string): Response {
  return Response.json({
    events: [{ seq: 1, event: 'message', message: { type: 'ai', content } }]
  })
}

afterEach(() => vi.unstubAllGlobals())

for (const staleOutcome of ['success', 'failure'] as const) {
  test(`changing the content address ignores a stale ${staleOutcome} even when fetch ignores abort`, async () => {
    // Cancellation alone is insufficient: a response can finish after navigation. The
    // remote content owner must keep old data and old failures out of the new timeline.
    const first = deferredResponse()
    const second = deferredResponse()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetch)
    const { rerender, unmount } = renderComponent(
      <TrajectoryContent contentHref="/first/trajectory" />
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const firstSignal = fetch.mock.calls[0]?.[1]?.signal
    rerender(<TrajectoryContent contentHref="/second/trajectory" />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)

    await act(async () => {
      second.resolve(trajectoryResponse('Current trajectory'))
    })
    expect(await screen.findByText('Current trajectory')).toBeVisible()
    await act(async () => {
      first.resolve(
        staleOutcome === 'success'
          ? trajectoryResponse('Stale trajectory')
          : new Response(null, { status: 503 })
      )
    })
    expect(screen.getByText('Current trajectory')).toBeVisible()
    expect(screen.queryByText('Stale trajectory')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/first/trajectory',
      '/api/second/trajectory'
    ])

    const secondSignal = fetch.mock.calls[1]?.[1]?.signal
    unmount()
    expect(secondSignal?.aborted).toBe(true)
  })
}

test('a failed trajectory load can recover when the content address changes', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(trajectoryResponse('Recovered trajectory'))
  )
  const { rerender } = renderComponent(
    <TrajectoryContent contentHref="/unavailable/trajectory" />
  )
  expect(await screen.findByRole('alert')).toBeVisible()

  rerender(<TrajectoryContent contentHref="/available/trajectory" />)
  expect(await screen.findByText('Recovered trajectory')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
