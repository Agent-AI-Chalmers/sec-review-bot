import { zstdDecompressSync } from 'node:zlib'

import {
  readTrajectoryJsonl,
  type TrajectoryEvent
} from '../../shared/trajectory-events.js'
export type { TrajectoryEvent } from '../../shared/trajectory-events.js'

export const MAX_TRAJECTORY_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_TRAJECTORY_CONTENT_BYTES = 8 * 1024 * 1024
const MAX_TRAJECTORY_LINE_BYTES = 512 * 1024
const MAX_TRAJECTORY_MESSAGES = 2000

export function readTrajectoryArtifact(bytes: Buffer): TrajectoryEvent[] {
  const content = zstdDecompressSync(bytes, {
    maxOutputLength: MAX_TRAJECTORY_CONTENT_BYTES
  })
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  for (const line of text.split('\n')) {
    if (Buffer.byteLength(line, 'utf8') > MAX_TRAJECTORY_LINE_BYTES)
      throw new Error('invalid_trajectory_artifact')
  }
  const events = readTrajectoryJsonl(text)
  if (
    events.filter((event) => event.event === 'message').length >
    MAX_TRAJECTORY_MESSAGES
  )
    throw new Error('invalid_trajectory_artifact')
  return events
}
