import type { TrajectoryEvent } from './trajectory-events.js'

/** JSON responses produced by this application's artifact preview routes. */
export interface MemoryTreeContentResponse {
  files: Record<string, string>
}

export interface RunArtifactContentResponse {
  files: Record<string, string>
  unpreviewable_files: Record<string, { sizeBytes: number }>
}

export interface TrajectoryContentResponse {
  events: TrajectoryEvent[]
}
