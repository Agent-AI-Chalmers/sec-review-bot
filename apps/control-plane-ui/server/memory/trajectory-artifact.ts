import { zstdDecompressSync } from 'node:zlib'

export const MAX_TRAJECTORY_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_TRAJECTORY_CONTENT_BYTES = 8 * 1024 * 1024
const MAX_TRAJECTORY_LINE_BYTES = 512 * 1024
const MAX_TRAJECTORY_MESSAGES = 2000

export interface TrajectoryEvent {
  seq: number
  event: 'message'
  message: Record<string, unknown>
}

/** Parse only the append-only trajectory shape produced by TrajectoryWriter.
 *
 * This deliberately does not accept arbitrary JSON arrays or Python reprs. The viewer is an
 * operational reader for one owned artifact format, so format drift must fail visibly instead
 * of being guessed into a plausible but inaccurate conversation.
 */
export function readTrajectoryArtifact(bytes: Buffer): TrajectoryEvent[] {
  const content = zstdDecompressSync(bytes, {
    maxOutputLength: MAX_TRAJECTORY_CONTENT_BYTES
  })
  const events: TrajectoryEvent[] = []
  let previousSeq = 0
  for (const rawLine of content.toString('utf8').split('\n')) {
    if (!rawLine.trim()) continue
    if (Buffer.byteLength(rawLine, 'utf8') > MAX_TRAJECTORY_LINE_BYTES)
      throw new Error('invalid_trajectory_artifact')
    const parsed: unknown = JSON.parse(rawLine)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('invalid_trajectory_artifact')
    const event = parsed as Record<string, unknown>
    if (
      !Number.isSafeInteger(event.seq) ||
      (event.seq as number) <= previousSeq ||
      event.event !== 'message' ||
      typeof event.message !== 'object' ||
      event.message === null ||
      Array.isArray(event.message)
    )
      throw new Error('invalid_trajectory_artifact')
    previousSeq = event.seq as number
    events.push({
      seq: previousSeq,
      event: 'message',
      message: event.message as Record<string, unknown>
    })
    if (events.length > MAX_TRAJECTORY_MESSAGES)
      throw new Error('invalid_trajectory_artifact')
  }
  return events
}
