import { expect, test } from 'vitest'

import {
  MAX_MINIMAP_MARKS,
  minimapBuckets,
  minimapMarkWidth,
  minimapTicks,
  nearestSegment
} from '../../browser/features/trajectory/trajectory-minimap.js'

test('a long message stays current while it covers the viewport center', () => {
  const segments = [
    { top: 0, height: 0.9 },
    { top: 0.9, height: 0.02 }
  ]
  // The short follower's center is closer to 0.8 than the long message's
  // center, but the viewport center is still inside the long message.
  expect(nearestSegment(segments, 0.8)).toBe(0)
  expect(nearestSegment(segments, 0.95)).toBe(1)
})

test('a viewport center between messages falls back to the nearest center', () => {
  const segments = [
    { top: 0, height: 0.2 },
    { top: 0.5, height: 0.2 }
  ]
  expect(nearestSegment(segments, 0.3)).toBe(0)
  expect(nearestSegment(segments, 0.42)).toBe(1)
})

test('an empty trajectory has no current segment to pick', () => {
  expect(nearestSegment([], 0.5)).toBe(0)
})

test('mark width encodes state, not message size', () => {
  expect(minimapMarkWidth(false, false)).toBe(12)
  expect(minimapMarkWidth(false, true)).toBe(18)
  expect(minimapMarkWidth(true, false)).toBe(20)
  expect(minimapMarkWidth(true, true)).toBe(20)
})

test('dense trajectories bucket marks without overlapping', () => {
  const count = 300
  const ticks = minimapTicks(count)
  const buckets = minimapBuckets(count, ticks)

  expect(buckets).toHaveLength(MAX_MINIMAP_MARKS)
  expect(buckets[0]?.start).toBe(0)
  expect(buckets.at(-1)?.end).toBe(count - 1)
  for (let index = 1; index < buckets.length; index += 1) {
    expect.assert(buckets[index].top > buckets[index - 1].top)
  }
  const gaps = buckets.slice(1).map((bucket, index) => bucket.top - buckets[index].top)
  expect.assert(Math.min(...gaps) > 2, `bucket marks must not overlap: ${gaps.join(', ')}`)
})

test('a sparse trajectory keeps one bucket per message', () => {
  const ticks = minimapTicks(3)
  const buckets = minimapBuckets(3, ticks)

  expect(buckets).toHaveLength(3)
  expect(buckets.map((bucket) => bucket.start)).toStrictEqual([0, 1, 2])
  expect(buckets[1]?.top).toBe(ticks.start + ticks.gap)
})
