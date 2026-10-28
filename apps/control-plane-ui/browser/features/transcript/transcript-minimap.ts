import type { TranscriptMessageView } from './transcript-model.js'

export interface MinimapSegment {
  message: TranscriptMessageView
  top: number
  height: number
}

export const MINIMAP_HEIGHT = 300
const MINIMAP_GROUP_HEIGHT = 240
const MINIMAP_TICK_GAP = 10
// Mark length reflects state, not message size. Normal marks are 12px, the
// mark under the pointer grows to 18px, and the current mark is 20px.
const MINIMAP_MARK_WIDTH = 12
const MINIMAP_PREVIEW_WIDTH = 18
const MINIMAP_CURRENT_WIDTH = 20

export function minimapTicks(count: number): { start: number; gap: number } {
  if (count <= 1) return { start: MINIMAP_HEIGHT / 2, gap: 0 }
  const gap = Math.min(MINIMAP_TICK_GAP, MINIMAP_GROUP_HEIGHT / (count - 1))
  return {
    start: (MINIMAP_HEIGHT - gap * (count - 1)) / 2,
    gap
  }
}

export function minimapMarkWidth(current: boolean, preview: boolean): number {
  if (current) return MINIMAP_CURRENT_WIDTH
  return preview ? MINIMAP_PREVIEW_WIDTH : MINIMAP_MARK_WIDTH
}

// One 10px slot per mark. Dense transcripts show groups in those slots
// instead of compressing every message into 240px.
export const MAX_MINIMAP_MARKS = 25

export interface MinimapBucket {
  start: number
  end: number
  top: number
}

/**
 * Dense transcripts compress several messages into one muted background mark.
 * The current message is not part of these buckets: the viewer draws it
 * separately at its exact position so only that mark is highlighted.
 */
export function minimapBuckets(
  count: number,
  ticks: { start: number; gap: number },
  maxMarks: number = MAX_MINIMAP_MARKS
): MinimapBucket[] {
  if (count === 0) return []
  const bucketSize = Math.max(1, Math.ceil(count / maxMarks))
  const buckets: MinimapBucket[] = []
  for (let start = 0; start < count; start += bucketSize) {
    const end = Math.min(count - 1, start + bucketSize - 1)
    buckets.push({
      start,
      end,
      top: ticks.start + ((start + end) / 2) * ticks.gap
    })
  }
  return buckets
}

/**
 * A message that covers the viewport center is current even when a shorter
 * neighbour's center is closer. Only a center in the gap between messages falls
 * back to the nearest center.
 */
export function nearestSegment(
  segments: readonly { top: number; height: number }[],
  center: number
): number {
  if (segments.length === 0) return 0
  let low = 0
  let high = segments.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    const segment = segments[middle]!
    if (segment.top + segment.height < center) low = middle + 1
    else high = middle
  }
  const candidate = segments[low]!
  if (center >= candidate.top) return low
  if (low === 0) return 0
  const previous = segments[low - 1]!
  const previousDistance = Math.abs(previous.top + previous.height / 2 - center)
  const candidateDistance = Math.abs(
    candidate.top + candidate.height / 2 - center
  )
  return previousDistance <= candidateDistance ? low - 1 : low
}

export function sameSegments(
  left: MinimapSegment[],
  right: MinimapSegment[]
): boolean {
  if (left.length !== right.length) return false
  return left.every((segment, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      segment.message === other.message &&
      segment.top === other.top &&
      segment.height === other.height
    )
  })
}
