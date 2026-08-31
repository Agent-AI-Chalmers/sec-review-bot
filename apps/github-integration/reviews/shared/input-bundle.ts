import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'

import {
  WORKSPACE_SNAPSHOT_TAR_NAME,
  createWorkspaceSnapshotTar
} from '../../infrastructure/runner/git-workspace.js'
import { writeInputBundleManifest } from '../../infrastructure/runner/input-bundle-manifest.js'
import { input_bundle_staging_root } from '../../config.js'

export function sanitizePathSegment (value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

export function createRunId (): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const suffix = crypto.randomBytes(4).toString('hex')
  return `run-${timestamp}-${suffix}`
}

export async function ensureCleanDirectory (dir_path: string): Promise<void> {
  await fs.rm(dir_path, { recursive: true, force: true })
  await fs.mkdir(dir_path, { recursive: true })
}

export function buildGitRemoteUrl (owner_login: string, repo_name: string): string {
  const serverUrl = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
  return `${serverUrl}/${owner_login}/${repo_name}.git`
}

export function createInputBundleRoot (
  ...segments: string[]
): string {
  return path.resolve(input_bundle_staging_root, ...segments.map(sanitizePathSegment))
}

export async function finalizeInputBundleWorkspace ({
  input_bundle_root,
  workspace_path,
  include_incremental_window
}: {
  input_bundle_root: string
  workspace_path: string
  include_incremental_window: boolean
}): Promise<void> {
  await createWorkspaceSnapshotTar({
    workspace_path,
    tar_path: path.join(input_bundle_root, WORKSPACE_SNAPSHOT_TAR_NAME)
  })
  await writeInputBundleManifest({
    input_bundle_root,
    include_incremental_window
  })
}
