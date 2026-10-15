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

/** Bundle-relative directory holding the setup declaration. */
export const SETUP_DECLARATION_DIR = 'setup'

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
  include_incremental_window,
  setup_declaration_path
}: {
  input_bundle_root: string
  workspace_path: string
  include_incremental_window: boolean
  /** Bundle-relative path to the setup declaration, if any. */
  setup_declaration_path?: string
}): Promise<void> {
  await createWorkspaceSnapshotTar({
    workspace_path,
    tar_path: path.join(input_bundle_root, WORKSPACE_SNAPSHOT_TAR_NAME)
  })
  await writeInputBundleManifest({
    input_bundle_root,
    include_incremental_window,
    ...(setup_declaration_path ? { setup_declaration_path } : {})
  })
}

export const SETUP_DECLARATION_FILE_NAME = 'setup.yml'

/**
 * Fetch the setup declaration from an exact default-branch commit and
 * place it at `setup/setup.yml` inside the bundle. Returns the
 * bundle-relative path, or null when the repository has no declaration (absence
 * is not an error -- the environment simply stays unbootstrapped).
 */
export async function materializeSetupDeclaration({
  input_bundle_root,
  default_sha,
  owner_login,
  repo_name,
  git_auth_token
}: {
  input_bundle_root: string
  default_sha: string
  owner_login: string
  repo_name: string
  git_auth_token?: string
}): Promise<string | null> {
  const content = await readRepositoryFileAtRef({
    commit_sha: default_sha,
    file_path: `.sec-review/${SETUP_DECLARATION_FILE_NAME}`,
    git_remote_url: buildGitRemoteUrl(owner_login, repo_name),
    ...(git_auth_token ? { git_auth_token } : {})
  })
  if (content === null) {
    return null
  }
  const relative_path = `${SETUP_DECLARATION_DIR}/${SETUP_DECLARATION_FILE_NAME}`
  const target_dir = path.join(input_bundle_root, SETUP_DECLARATION_DIR)
  await fs.mkdir(target_dir, { recursive: true })
  await fs.writeFile(path.join(target_dir, SETUP_DECLARATION_FILE_NAME), content, 'utf8')
  return relative_path
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
  const include_setup_declaration = await fs
    .stat(path.join(input_bundle_root, SETUP_DECLARATION_DIR))
    .then((stat) => stat.isDirectory())
    .catch(() => false)
  const entries = [
    'manifest.json',
    WORKSPACE_SNAPSHOT_TAR_NAME,
    'history',
    ...(include_incremental_window ? ['incremental-window'] : []),
    ...(include_setup_declaration ? [SETUP_DECLARATION_DIR] : [])
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
