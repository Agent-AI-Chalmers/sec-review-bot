import fs from 'fs/promises'
import path from 'path'

import type { Octokit } from 'octokit'

import { exportWorkspaceWindow } from '../../artifacts/git-workspace.js'
import type { RepositoryScanScope } from '../../runner/input.js'
import type { RepositoryContext } from './submit.js'

/**
 * One entry of `changed-files.json`.
 *
 * The three identity fields are the contract's, and their type comes from the schema through
 * `RepositoryScanScope`, so `status` cannot drift to a value the scan scope does not accept. The
 * line counts are artifact-only: the runner's scan scope does not carry them.
 */
export type ChangedFileRecord =
  RepositoryScanScope['incremental_changed_files'][number] & {
    additions: number
    deletions: number
    changes: number
  }

export async function materializeIncrementalArtifacts({
  workspace_path,
  incremental_window_path,
  history_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  incremental_window_path: string
  history_path: string
  base_sha: string
  head_sha: string
}): Promise<{
  changed_files: ChangedFileRecord[]
  commit_shas: string[]
}> {
  await fs.mkdir(incremental_window_path, { recursive: true })
  await fs.mkdir(history_path, { recursive: true })

  // The workspace already holds both commits, so the patch and the file list come from the same
  // local comparison. The API cannot serve them: `GET /compare` caps its file list at 300 and its
  // diff media type at roughly 3 MB, truncating mid-file, so a large window would produce a patch
  // and a file list describing different change sets -- and a patch that is not valid.
  const {
    patch: patchText,
    files,
    commit_shas
  } = await exportWorkspaceWindow({
    workspace_path,
    base_sha,
    head_sha
  })
  await fs.writeFile(
    path.join(incremental_window_path, 'incremental.patch'),
    patchText,
    'utf8'
  )

  // The workspace export already reports the contract's status vocabulary and keeps the
  // previous path for a rename or copy, so this is a projection into the artifact's shape and not
  // a second translation. Re-deriving either value here is what made `removed` reach discovery.
  const changed_files: ChangedFileRecord[] = files
    .map((file) => ({
      path: file.filename,
      status: file.status,
      previous_path: file.previous_path,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  await fs.writeFile(
    path.join(incremental_window_path, 'changed-files.json'),
    JSON.stringify({ base_sha, head_sha, files: changed_files }, null, 2),
    'utf8'
  )

  return {
    changed_files,
    commit_shas
  }
}

export async function isAncestorCommit({
  octokit,
  repo,
  base_sha,
  head_sha
}: {
  octokit: Octokit
  repo: RepositoryContext
  base_sha: string
  head_sha: string
}): Promise<boolean> {
  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: repo.owner_login,
    repo: repo.repo_name,
    basehead: `${base_sha}...${head_sha}`
  })
  return (
    String(compare.data?.status ?? '')
      .trim()
      .toLowerCase() === 'ahead'
  )
}
