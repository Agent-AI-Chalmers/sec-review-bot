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
import {
  MAX_SETUP_DECLARATION_BYTES,
  SetupDeclarationError,
  isSetupDeclarationError,
  parseSetupDeclaration
} from '../../github/setup-declaration.js'
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
 * Read and validate the setup declaration from an exact default-branch commit.
 *
 * Returns the declaration text, or null when the repository has none (a missing
 * file, or a file that holds only whitespace, both mean "no declaration").
 *
 * The integration owns the content rules: a declaration that exists but is not
 * valid is rejected here, before submission, with the repository/ref/path
 * context attached. A broken `.sec-review/setup.yml` on the default branch is a
 * maintainer error that should fail loudly rather than silently degrade into an
 * unbootstrapped environment (which would let the agent reason about a
 * repository whose dependencies were never installed). This matches how an
 * invalid `.sec-review/config.yml` is handled.
 *
 * The validated text is passed inline in the workflow input; it is not written
 * to the bundle.
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
  const path = `.sec-review/${SETUP_DECLARATION_FILE_NAME}`
  const declaration = await readRepositoryFileAtRef({
    commit_sha: default_sha,
    file_path: path,
    git_remote_url: buildGitRemoteUrl(owner_login, repo_name),
    ...(git_auth_token ? { git_auth_token } : {})
  })
  if (declaration === null) {
    return null
  }
  if (Buffer.byteLength(declaration, 'utf8') > MAX_SETUP_DECLARATION_BYTES) {
    throw new SetupDeclarationError(
      `Setup declaration exceeds ${MAX_SETUP_DECLARATION_BYTES} bytes.`,
      { reason: 'declaration-too-large', owner_login, repo_name, ref: default_sha, path }
    )
  }
  try {
    if (parseSetupDeclaration(declaration) === null) {
      return null
    }
  } catch (error) {
    if (isSetupDeclarationError(error)) {
      error.owner_login = owner_login
      error.repo_name = repo_name
      error.ref = default_sha
      error.path = path
    }
    throw error
  }
  return declaration
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
