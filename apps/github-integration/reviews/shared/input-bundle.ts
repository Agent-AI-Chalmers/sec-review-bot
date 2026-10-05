import crypto from 'crypto'
import { execFile } from 'child_process'
import { createReadStream, createWriteStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { createZstdCompress } from 'zlib'

import type { InputBundleArtifactRef } from '../../infrastructure/runner/input.js'

import {
  WORKSPACE_SNAPSHOT_TAR_NAME,
  createWorkspaceSnapshotTar
} from '../../infrastructure/runner/git-workspace.js'
import { writeInputBundleManifest } from '../../infrastructure/runner/input-bundle-manifest.js'
import { input_bundle_staging_root } from '../../config.js'

const execFileAsync = promisify(execFile)
export const INPUT_BUNDLE_MEDIA_TYPE = 'application/vnd.sec-review.input-bundle.v1+tar+zstd'

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

export async function archiveInputBundle ({
  input_bundle_root,
  include_incremental_window
}: {
  input_bundle_root: string
  include_incremental_window: boolean
}): Promise<InputBundleArtifactRef> {
  const tarPath = `${input_bundle_root}.tar`
  const archivePath = `${tarPath}.zst`
  const entries = [
    'manifest.json',
    WORKSPACE_SNAPSHOT_TAR_NAME,
    'history',
    ...(include_incremental_window ? ['incremental-window'] : [])
  ]
  await fs.rm(tarPath, { force: true })
  await fs.rm(archivePath, { force: true })
  // Keep the workspace snapshot as an inner, uncompressed tar: Runner stages
  // reuse it to create isolated workspaces. Only the transport bundle is zstd
  // compressed, and the live staging checkout is deliberately not included.
  await execFileAsync('tar', ['-cf', tarPath, '-C', input_bundle_root, ...entries])
  await pipeline(
    createReadStream(tarPath),
    createZstdCompress(),
    createWriteStream(archivePath)
  )
  await fs.rm(tarPath, { force: true })
  const digest = crypto.createHash('sha256')
  await pipeline(createReadStream(archivePath), digest)
  const { size } = await fs.stat(archivePath)
  const reference: InputBundleArtifactRef = {
    uri: pathToFileURL(archivePath).href,
    digest: `sha256:${digest.digest('hex')}`,
    media_type: INPUT_BUNDLE_MEDIA_TYPE,
    size_bytes: size
  }
  // The snapshot in the archive is now the durable execution input. Removing
  // the live checkout avoids retaining a second repository copy in staging.
  await fs.rm(path.join(input_bundle_root, 'workspace'), { recursive: true, force: true })
  return reference
}
