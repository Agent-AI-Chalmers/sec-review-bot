import crypto from 'crypto'
import { execFile } from 'child_process'
import { createReadStream, createWriteStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { createZstdCompress } from 'zlib'

import {
  INPUT_BUNDLE_MEDIA_TYPE,
  MAX_WORKFLOW_INPUT_BYTES,
  type InputBundleArtifactRef
} from '../../execution/input.js'
import {
  publishedInputBundleReference,
  publishInputBundle
} from '../../artifacts/input-storage.js'

import {
  WORKSPACE_SNAPSHOT_TAR_NAME,
  createWorkspaceSnapshotTar
} from '../../artifacts/git-workspace.js'
import type { Octokit } from 'octokit'
import { writeInputBundleManifest } from '../../execution/input-bundle-manifest.js'
import {
  MAX_SETUP_DECLARATION_BYTES,
  SetupDeclarationError,
  isSetupDeclarationError,
  parseSetupDeclaration
} from '../../github/setup-declaration.js'
import { asErrorWithResponse, isRecord } from '../../utils/error-utils.js'
import { input_bundle_staging_root } from '../../config.js'

const execFileAsync = promisify(execFile)

/**
 * Refuse a workflow input that will not survive transport.
 *
 * The schema's `maxItems` bounds how many entries an input carries, not how large it is: a Git
 * path can be thousands of bytes, so a few thousand entries can serialize to tens of megabytes.
 * The input travels through Temporal and is persisted, and both fail far from the cause when the
 * payload is too large, so the size is checked here, against the bound the contract declares.
 */
export function assertWorkflowInputFits(
  input: unknown,
  workflow: string
): void {
  const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  if (bytes > MAX_WORKFLOW_INPUT_BYTES) {
    throw new Error(
      `${workflow} input is ${bytes} bytes, which exceeds the workflow input limit of ` +
        `${MAX_WORKFLOW_INPUT_BYTES}`
    )
  }
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

export async function ensureCleanDirectory(dir_path: string): Promise<void> {
  await fs.rm(dir_path, { recursive: true, force: true })
  await fs.mkdir(dir_path, { recursive: true })
}

export function buildGitRemoteUrl(
  owner_login: string,
  repo_name: string
): string {
  const serverUrl = (
    process.env.GITHUB_SERVER_URL || 'https://github.com'
  ).replace(/\/+$/, '')
  return `${serverUrl}/${owner_login}/${repo_name}.git`
}

export function createInputBundleRoot(...segments: string[]): string {
  return path.resolve(
    input_bundle_staging_root,
    ...segments.map(sanitizePathSegment)
  )
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
  octokit,
  default_sha,
  owner_login,
  repo_name
}: {
  octokit: Octokit
  default_sha: string
  owner_login: string
  repo_name: string
}): Promise<string | null> {
  const path = `.sec-review/${SETUP_DECLARATION_FILE_NAME}`
  const declaration = await readRepositoryFileAtSha({
    octokit,
    owner_login,
    repo_name,
    sha: default_sha,
    path
  })
  if (declaration === null) {
    return null
  }
  if (Buffer.byteLength(declaration, 'utf8') > MAX_SETUP_DECLARATION_BYTES) {
    throw new SetupDeclarationError(
      `Setup declaration exceeds ${MAX_SETUP_DECLARATION_BYTES} bytes.`,
      {
        reason: 'declaration-too-large',
        owner_login,
        repo_name,
        ref: default_sha,
        path
      }
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

/**
 * Read a single file at an exact commit through the Contents API.
 *
 * Reading by API at the already-resolved SHA avoids a second git clone, and
 * avoids relying on the server allowing a wanted-SHA fetch. A missing file is
 * `404` -> `null` (the normal "no declaration" case); any other failure
 * propagates so input preparation fails loudly rather than silently skipping a
 * declaration the default branch actually has.
 */
async function readRepositoryFileAtSha({
  octokit,
  owner_login,
  repo_name,
  sha,
  path
}: {
  octokit: Octokit
  owner_login: string
  repo_name: string
  sha: string
  path: string
}): Promise<string | null> {
  let response: { data: unknown }
  try {
    response = await octokit.rest.repos.getContent({
      owner: owner_login,
      repo: repo_name,
      path,
      ref: sha
    })
  } catch (error) {
    if (asErrorWithResponse(error).status === 404) {
      return null
    }
    throw error
  }
  // A file path returns a single content object; an array means the path
  // resolved to a directory, which is not a declaration.
  if (Array.isArray(response.data)) {
    return null
  }
  if (!isRecord(response.data) || typeof response.data.content !== 'string') {
    return null
  }
  // Only a regular file is a declaration. A symlink is returned as an object
  // whose `content` is the base64 of the *target path*, not the file body, so
  // treating it as a declaration would feed the target string to the parser.
  // Anything that is not `file` (symlink, submodule, ...) means "no declaration".
  if (response.data.type !== 'file') {
    return null
  }
  return Buffer.from(response.data.content, 'base64').toString('utf-8')
}

export async function archiveInputBundle({
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
    'history',
    ...(include_incremental_window ? ['incremental-window'] : []),
    WORKSPACE_SNAPSHOT_TAR_NAME
  ]
  await fs.rm(tarPath, { force: true })
  await fs.rm(archivePath, { force: true })
  // Keep the workspace snapshot as an inner, uncompressed tar: Execution Worker stages
  // reuse it to create isolated workspaces. Only the transport bundle is zstd
  // compressed, and the live staging checkout is deliberately not included.
  await execFileAsync('tar', [
    '--format=posix',
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mode=u+rwX,go+rX,go-w',
    '--pax-option=delete=atime,delete=ctime',
    '-cf',
    tarPath,
    '-C',
    input_bundle_root,
    ...entries
  ])
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
  await fs.rm(path.join(input_bundle_root, 'workspace'), {
    recursive: true,
    force: true
  })
  return reference
}

/**
 * Archive the bundle, confirm the input that references it fits, then publish.
 *
 * The order matters: publishing first would leave an immutable, unreferenced bundle behind
 * whenever the input turns out to be too large. The bundle has to exist before the input can be
 * sized, because the input carries the bundle's digest, so publication is the step that waits.
 */
export async function archiveInputBundleAndPublish<T>({
  input_bundle_root,
  include_incremental_window,
  run_id,
  build_input,
  workflow,
  publish = publishInputBundle,
  project_published = publishedInputBundleReference
}: {
  input_bundle_root: string
  include_incremental_window: boolean
  run_id: string
  build_input: (reference: InputBundleArtifactRef) => T
  workflow: string
  /** The publication step, injectable so a test can observe that it runs last. */
  publish?: typeof publishInputBundle
  /**
   * The projection from the archived reference to the published one. Injectable because the
   * real projection depends on process configuration: under the file-backed store it returns
   * the reference unchanged, so a test could not otherwise exercise the URI rewrite that the S3
   * store performs.
   */
  project_published?: typeof publishedInputBundleReference
}): Promise<{
  input: T
  input_bundle: InputBundleArtifactRef
}> {
  const local_reference = await archiveInputBundle({
    input_bundle_root,
    include_incremental_window
  })
  // The published URI is known before the upload (it is derived from the run id), so the input
  // can be built against the reference that will actually be submitted and sized once, before
  // anything reaches object storage. A local `file:` URI in the input would be unreadable from a
  // remote worker, and an oversized input rejected after publication would leave an immutable
  // bundle with nothing pointing at it.
  const published_reference = project_published(local_reference, run_id)
  const input = build_input(published_reference)
  assertWorkflowInputFits(input, workflow)

  await publish(local_reference, run_id)
  return {
    input,
    input_bundle: published_reference
  }
}
