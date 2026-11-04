import React from 'react'

import { api, apiPost } from '../../shared/api-client.js'

interface EditorFiles {
  initialFiles: Record<string, string>
  files: Record<string, string>
}

interface MemoryEditSession extends EditorFiles {
  baseRevision: number
  attempt?: { content: string; operationId: string }
}

interface MemoryEditor {
  session: EditorFiles | undefined
  begin(baseRevision: number): Promise<void>
  changeFiles(files: Record<string, string>): void
  close(): void
  commit(): Promise<void>
}

/** Own the edit's base revision and retry identity; the page owns operation feedback and refresh. */
export function useMemoryEditor(): MemoryEditor {
  const [session, setSession] = React.useState<MemoryEditSession>()

  const begin = async (baseRevision: number): Promise<void> => {
    // The revision is captured before loading; catalog refreshes cannot change this edit's base.
    const files =
      baseRevision === 0
        ? { 'MEMORY.md': '# Security Review Experience Memory\n' }
        : (
            await api<{ files: Record<string, string> }>(
              `/memory/revisions/${baseRevision}/content`
            )
          ).files
    setSession({ baseRevision, files, initialFiles: files })
  }

  const changeFiles = (files: Record<string, string>): void => {
    setSession((previous) =>
      previous === undefined ? undefined : { ...previous, files }
    )
  }

  const close = (): void => setSession(undefined)

  const commit = async (): Promise<void> => {
    if (session === undefined) return
    const content = JSON.stringify(
      Object.entries(session.files).sort(([a], [b]) => a.localeCompare(b))
    )
    // Retain the attempt before sending: a lost response must be retried with the same identity.
    const attempt =
      session.attempt?.content === content
        ? session.attempt
        : { content, operationId: crypto.randomUUID() }
    setSession({ ...session, attempt })
    await apiPost('/memory/edit', {
      operation_id: attempt.operationId,
      expected_active_revision: session.baseRevision,
      files: session.files
    })
    close()
  }

  return { session, begin, changeFiles, close, commit }
}
