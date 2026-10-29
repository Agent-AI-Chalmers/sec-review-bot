import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_MINIMAP_MARKS,
  minimapBuckets,
  minimapMarkWidth,
  minimapTicks,
  nearestSegment
} from '../browser/features/trajectory/trajectory-minimap.js'

test('a long message stays current while it covers the viewport center', () => {
  const segments = [
    { top: 0, height: 0.9 },
    { top: 0.9, height: 0.02 }
  ]
  // The short follower's center is closer to 0.8 than the long message's
  // center, but the viewport center is still inside the long message.
  assert.equal(nearestSegment(segments, 0.8), 0)
  assert.equal(nearestSegment(segments, 0.95), 1)
})

test('a viewport center between messages falls back to the nearest center', () => {
  const segments = [
    { top: 0, height: 0.2 },
    { top: 0.5, height: 0.2 }
  ]
  assert.equal(nearestSegment(segments, 0.3), 0)
  assert.equal(nearestSegment(segments, 0.42), 1)
})

test('an empty trajectory has no current segment to pick', () => {
  assert.equal(nearestSegment([], 0.5), 0)
})

test('mark width encodes state, not message size', () => {
  assert.equal(minimapMarkWidth(false, false), 12)
  assert.equal(minimapMarkWidth(false, true), 18)
  assert.equal(minimapMarkWidth(true, false), 20)
  assert.equal(minimapMarkWidth(true, true), 20)
})

test('dense trajectories bucket marks without overlapping', () => {
  const count = 300
  const ticks = minimapTicks(count)
  const buckets = minimapBuckets(count, ticks)

  assert.equal(buckets.length, MAX_MINIMAP_MARKS)
  assert.equal(buckets[0]?.start, 0)
  assert.equal(buckets.at(-1)?.end, count - 1)
  for (let index = 1; index < buckets.length; index += 1)
    assert.ok(buckets[index]!.top > buckets[index - 1]!.top)
  const gaps = buckets
    .slice(1)
    .map((bucket, index) => bucket.top - buckets[index]!.top)
  assert.ok(
    Math.min(...gaps) > 2,
    `bucket marks must not overlap: ${gaps.join(', ')}`
  )
})

test('a sparse trajectory keeps one bucket per message', () => {
  const ticks = minimapTicks(3)
  const buckets = minimapBuckets(3, ticks)

  assert.equal(buckets.length, 3)
  assert.deepEqual(
    buckets.map((bucket) => bucket.start),
    [0, 1, 2]
  )
  assert.equal(buckets[1]?.top, ticks.start + ticks.gap)
})
