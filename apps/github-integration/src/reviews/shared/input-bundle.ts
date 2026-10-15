import crypto from 'crypto'
import { execFile } from 'child_process'
import { createReadStream, createWriteStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { createZstdCompress } from 'zlib'

import { INPUT_BUNDLE_MEDIA_TYPE, type InputBundleArtifactRef } from '../../runner/input.js'
import { publishInputBundle } from '../../artifacts/input-storage.js'

import {
  WORKSPACE_SNAPSHOT_TAR_NAME,
  createWorkspaceSnapshotTar,
  readRepositoryFileAtRef
} from '../../artifacts/git-workspace.js'
import { writeInputBundleManifest } from '../../runner/input-bundle-manifest.js'
import { input_bundle_staging_root } from '../../config.js'

const execFileAsync = promisify(execFile)

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

export async function ensureCleanDirectory(dir_path: string): Promise<void> {
  await fs.rm(dir_path, { recursive: true, force: true })
  await fs.mkdir(dir_path, { recursive: true })
}

export function buildGitRemoteUrl(owner_login: string, repo_name: string): string {
  const serverUrl = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
  return `${serverUrl}/${owner_login}/${repo_name}.git`
}

export function createInputBundleRoot(...segments: string[]): string {
  return path.resolve(input_bundle_staging_root, ...segments.map(sanitizePathSegment))
}

export async function finalizeInputBundleWorkspace({
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

export const SETUP_DECLARATION_FILE_NAME = 'setup.yml'

/**
 * Read the setup declaration text from an exact default-branch commit.
 * Returns the declaration contents, or null when the repository has none
 * (absence is not an error -- the environment simply stays unbootstrapped).
 * The text is passed inline in the workflow input; it is not written to the
 * bundle.
 */
export async function readSetupDeclaration({
  default_sha,
  owner_login,
  repo_name,
  git_auth_token
}: {
  default_sha: string
  owner_login: string
  repo_name: string
  git_auth_token?: string
}): Promise<string | null> {
  return readRepositoryFileAtRef({
    commit_sha: default_sha,
    file_path: `.sec-review/${SETUP_DECLARATION_FILE_NAME}`,
    git_remote_url: buildGitRemoteUrl(owner_login, repo_name),
    ...(git_auth_token ? { git_auth_token } : {})
  })
}

export async function archiveInputBundle({
  input_bundle_root,
  include_incremental_window,
  run_id
}: {
  input_bundle_root: string
  include_incremental_window: boolean
  run_id: string
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
  await pipeline(createReadStream(tarPath), createZstdCompress(), createWriteStream(archivePath))
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
  return await publishInputBundle(reference, run_id)
}
