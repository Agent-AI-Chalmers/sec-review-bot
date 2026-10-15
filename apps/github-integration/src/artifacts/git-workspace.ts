import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

import { logWarn } from '../utils/logger.js'

const execFileAsync = promisify(execFile)
export const WORKSPACE_SNAPSHOT_TAR_NAME = 'workspace.snapshot.tar'

const SHA_RE = /^[0-9a-fA-F]{7,64}$/
const GIT_FETCH_MAX_ATTEMPTS = 3
const GIT_FETCH_INITIAL_RETRY_DELAY_MS = 1_000

// Bound every git subprocess so a hung fetch, checkout, or gc cannot stall
// input preparation forever. The default is generous: a cold clone of a large
// repository with a slow proxy can legitimately take minutes. Operators whose
// repositories exceed it can raise it through the environment.
const GIT_COMMAND_TIMEOUT_ENV = 'GITHUB_INTEGRATION_GIT_TIMEOUT_MS'
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 600_000
type Sleep = (delay_ms: number) => Promise<void>

/** Resolve the per-command timeout, validating the environment override. */
export function configuredGitTimeoutMs(configured = process.env[GIT_COMMAND_TIMEOUT_ENV]): number {
  if (configured === undefined || configured.trim() === '') {
    return DEFAULT_GIT_COMMAND_TIMEOUT_MS
  }
  const parsed = Number.parseInt(configured, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== configured.trim()) {
    throw new Error(`${GIT_COMMAND_TIMEOUT_ENV} must be a positive integer.`)
  }
  return parsed
}

// Materialization flow for real-history workspaces:
// 1. fetch only the requested refs in a temporary git repository;
// 2. checkout the target commit detached;
// 3. remove remotes, fetch metadata, reflogs, and unreachable objects;
// 4. move the sanitized git workspace into the agent input bundle.
// This keeps git diff/apply capabilities without handing the agent the fetch/auth workspace.

interface GitCommandOptions {
  config?: string[]
  env?: Record<string, string | undefined>
  timeout_ms?: number
}

interface GitAskPassAuth {
  cleanup: () => Promise<void>
  config: string[]
  env: Record<string, string | undefined>
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function createGitAskPassAuth(git_auth_token: string): Promise<GitAskPassAuth> {
  // Keep the installation token out of git argv; argv can be visible to other local processes.
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-git-auth-'))
  await fs.chmod(authDir, 0o700)
  const tokenPath = path.join(authDir, 'token')
  const askPassPath = path.join(authDir, 'askpass.sh')
  await fs.writeFile(tokenPath, git_auth_token, { mode: 0o600 })
  await fs.writeFile(
    askPassPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*|*username*)',
      "    printf '%s\\n' 'x-access-token'",
      '    ;;',
      '  *)',
      `    cat ${shellSingleQuote(tokenPath)}`,
      "    printf '\\n'",
      '    ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )

  return {
    config: ['credential.helper=', 'credential.interactive=never'],
    env: {
      GIT_ASKPASS: askPassPath,
      SSH_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: '0'
    },
    cleanup: async () => {
      await fs.rm(authDir, { recursive: true, force: true })
    }
  }
}

async function runGitCommand(
  workspace_path: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<void> {
  const configArgs = (options.config ?? []).flatMap((item) => ['-c', item])
  await execFileAsync('git', [...configArgs, ...args], {
    cwd: workspace_path,
    timeout: options.timeout_ms ?? configuredGitTimeoutMs(),
    env: {
      ...process.env,
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_TERMINAL_PROMPT: '0',
      ...(options.env ?? {})
    }
  })
}

export async function retryGitFetch(
  operation: () => Promise<void>,
  sleep: Sleep = delay
): Promise<void> {
  for (let attempt = 1; attempt <= GIT_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      if (attempt === GIT_FETCH_MAX_ATTEMPTS) {
        throw error
      }

      const delay_ms = GIT_FETCH_INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1)
      logWarn('git_fetch_retry_scheduled', {
        attempt,
        next_attempt: attempt + 1,
        delay_ms
      })
      await sleep(delay_ms)
    }
  }
}

async function delay(delay_ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delay_ms))
}

async function runGitFetchWithRetry(
  workspace_path: string,
  args: string[],
  options: GitCommandOptions
): Promise<void> {
  await retryGitFetch(() =>
    runGitCommand(workspace_path, args, withConfiguredGitFetchProxy(options))
  )
}

export function withConfiguredGitFetchProxy(
  options: GitCommandOptions,
  configured_proxy = process.env.GITHUB_INTEGRATION_GIT_HTTP_PROXY
): GitCommandOptions {
  const proxy = configured_proxy?.trim()
  if (!proxy) {
    return options
  }

  // Scope the proxy to repository materialization. GitHub API calls and
  // communication with other Compose services keep their existing routes.
  return {
    ...options,
    env: {
      ...(options.env ?? {}),
      http_proxy: proxy,
      https_proxy: proxy
    }
  }
}

async function requireWorkspaceCommand(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args)
  } catch (error) {
    const cause = error instanceof Error && error.message ? ` ${error.message}` : ''
    throw new Error(
      `GitHub integration workspace preparation requires '${command}' in PATH.${cause}`,
      { cause: error }
    )
  }
}

export async function verifyGitWorkspaceRuntime(): Promise<void> {
  await requireWorkspaceCommand('git', ['--version'])
  await requireWorkspaceCommand('tar', ['--version'])
}

async function initializeWorkspaceGitRepository({
  workspace_path
}: {
  workspace_path: string
}): Promise<void> {
  await fs.mkdir(workspace_path, { recursive: true })
  await runGitCommand(workspace_path, ['init'])
  await runGitCommand(workspace_path, ['config', 'user.name', 'sec-review-bot'])
  await runGitCommand(workspace_path, ['config', 'user.email', 'sec-review-bot@localhost'])
}

async function sanitizeMaterializedGitWorkspace(workspace_path: string): Promise<void> {
  // The agent needs real git objects for diffs, but not remotes, credentials, or fetch metadata.
  await runGitCommand(workspace_path, ['remote', 'remove', 'origin']).catch(() => {})
  await fs.rm(path.join(workspace_path, '.git', 'FETCH_HEAD'), { force: true })
  await fs.rm(path.join(workspace_path, '.git', 'ORIG_HEAD'), { force: true })
  await fs.rm(path.join(workspace_path, '.git', 'logs'), { recursive: true, force: true })
  await runGitCommand(workspace_path, ['reflog', 'expire', '--expire=now', '--all']).catch(() => {})
  await runGitCommand(workspace_path, ['gc', '--prune=now'])
}

async function compactWorkspaceGitObjectsBeforeSnapshot(workspace_path: string): Promise<void> {
  const gitDir = path.join(workspace_path, '.git')
  try {
    const stat = await fs.stat(gitDir)
    if (!stat.isDirectory()) {
      return
    }
  } catch {
    return
  }

  // Snapshot the workspace after an explicit compaction pass so the archive
  // does not capture a repository mid-transition between loose and packed
  // objects.
  await runGitCommand(workspace_path, ['gc', '--prune=now'], {
    config: ['gc.auto=0']
  })
}

async function replaceWorkspaceWithMaterializedRepository({
  workspace_path,
  materialized_path
}: {
  workspace_path: string
  materialized_path: string
}): Promise<void> {
  await fs.rm(workspace_path, { recursive: true, force: true })
  await fs.mkdir(path.dirname(workspace_path), { recursive: true })
  await fs.rename(materialized_path, workspace_path)
}

async function materializeWorkspaceFromRealGitHistory({
  workspace_path,
  git_remote_url,
  refs,
  git_auth_token
}: {
  workspace_path: string
  git_remote_url: string
  refs: string[]
  git_auth_token?: string
}): Promise<void> {
  await fs.mkdir(path.dirname(workspace_path), { recursive: true })
  const materialized_path = await fs.mkdtemp(
    path.join(path.dirname(workspace_path), '.workspace-fetch-')
  )

  try {
    await initializeWorkspaceGitRepository({ workspace_path: materialized_path })
    await runGitCommand(materialized_path, ['remote', 'add', 'origin', git_remote_url])

    const auth = git_auth_token ? await createGitAskPassAuth(git_auth_token) : null
    try {
      const fetchArgs = [
        'fetch',
        '--no-tags',
        // Single-ref materialization keeps a real HEAD workspace while
        // bounding issue/full runs to a shallow history window. Multi-ref
        // materialization keeps the history relationships needed by PR
        // and incremental review flows.
        ...(refs.length === 1 ? ['--depth=1'] : []),
        'origin',
        // Keep refs from being interpreted as fetch options if a future caller
        // passes a branch-like value instead of a resolved commit SHA.
        '--',
        ...refs
      ]
      await runGitFetchWithRetry(
        materialized_path,
        fetchArgs,
        auth ? { config: auth.config, env: auth.env } : {}
      )
    } finally {
      await auth?.cleanup()
    }

    const head_ref = refs[refs.length - 1]
    if (!head_ref) {
      throw new Error('materializeWorkspaceFromRealGitHistory requires at least one ref.')
    }
    await runGitCommand(materialized_path, ['checkout', '--detach', head_ref])
    await sanitizeMaterializedGitWorkspace(materialized_path)
    await replaceWorkspaceWithMaterializedRepository({
      workspace_path,
      materialized_path
    })
  } catch (error) {
    await fs.rm(materialized_path, { recursive: true, force: true })
    throw error
  }
}

export async function materializeWorkspaceWithCommitHistory({
  workspace_path,
  refs,
  git_remote_url,
  git_auth_token
}: {
  workspace_path: string
  refs: string[]
  git_remote_url?: string
  git_auth_token?: string
}): Promise<void> {
  const normalizedRefs = refs
    .map((item) => String(item).trim())
    .filter((item, index, array) => item !== '' && array.indexOf(item) === index)

  if (normalizedRefs.length === 0) {
    throw new Error('materializeWorkspaceWithCommitHistory requires at least one ref.')
  }

  for (const ref of normalizedRefs) {
    if (ref.startsWith('-')) {
      throw new Error('materializeWorkspaceWithCommitHistory refs must not start with "-".')
    }
  }

  if (!git_remote_url || git_remote_url.trim() === '') {
    throw new Error('materializeWorkspaceWithCommitHistory requires git_remote_url.')
  }
  // PR and repository reviews rely on real commit relationships; snapshot
  // archives must not be silently promoted into synthetic git history.
  await materializeWorkspaceFromRealGitHistory({
    workspace_path,
    git_remote_url: git_remote_url.trim(),
    refs: normalizedRefs,
    ...(git_auth_token ? { git_auth_token } : {})
  })
}

export async function createWorkspaceSnapshotTar({
  workspace_path,
  tar_path
}: {
  workspace_path: string
  tar_path: string
}): Promise<void> {
  await compactWorkspaceGitObjectsBeforeSnapshot(workspace_path)
  await fs.mkdir(path.dirname(tar_path), { recursive: true })
  const tempPath = path.join(
    path.dirname(tar_path),
    `.${path.basename(tar_path)}.${process.pid}.${Date.now()}.tmp`
  )

  try {
    await execFileAsync(
      'tar',
      ['-cf', tempPath, '-C', path.dirname(workspace_path), path.basename(workspace_path)],
      { timeout: configuredGitTimeoutMs() }
    )
    await fs.rename(tempPath, tar_path)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read a single file at an exact commit from the remote, without checking out a
 * workspace. Used to fetch the setup declaration from the repository's
 * default-branch SHA (which the PR workspace does not necessarily contain).
 *
 * Returns the file content, or `null` if the file does not exist at that commit.
 */
export async function readRepositoryFileAtRef({
  commit_sha,
  file_path,
  git_remote_url,
  git_auth_token
}: {
  commit_sha: string
  file_path: string
  git_remote_url?: string
  git_auth_token?: string
}): Promise<string | null> {
  const normalizedSha = String(commit_sha).trim()
  const normalizedPath = String(file_path).trim()
  // The SHA is passed to `git fetch` as a ref and to `git show` as
  // `<sha>:<path>`. Restrict it to a hexadecimal object name so it cannot be
  // read as a git option (`--upload-pack=...`) or a revision expression
  // (`HEAD@{...}`, `refs/...`). The trusted caller always passes the full,
  // API-resolved default-branch SHA.
  if (!SHA_RE.test(normalizedSha)) {
    throw new Error(`readRepositoryFileAtRef requires a hexadecimal commit SHA: ${commit_sha}`)
  }
  // Reject anything that is not a plain repository-relative path: absolute
  // paths, `..` traversal, and leading `-` (which `git show` would read as an
  // option). The caller passes a constant path today; this is defense in depth
  // for future callers.
  if (
    !normalizedPath ||
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('-') ||
    normalizedPath.includes('..')
  ) {
    throw new Error(`readRepositoryFileAtRef received an invalid file path: ${file_path}`)
  }
  if (!git_remote_url || git_remote_url.trim() === '') {
    throw new Error('readRepositoryFileAtRef requires git_remote_url.')
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-setup-declaration-'))
  try {
    await runGitCommand(tempDir, ['init', '--quiet'])
    await runGitCommand(tempDir, ['remote', 'add', 'origin', git_remote_url.trim()])

    const auth = git_auth_token ? await createGitAskPassAuth(git_auth_token) : null
    try {
      await runGitFetchWithRetry(tempDir, ['fetch', '--depth', '1', 'origin', normalizedSha], {
        ...(auth ? { config: auth.config, env: auth.env } : {})
      })

      // Decide "the file is absent" by exit code, not by matching git's error
      // wording: the object is already fetched, so `cat-file -e` succeeds exactly
      // when the path exists at that commit. This keeps a missing
      // `.sec-review/setup.yml` (the normal case) from depending on a message a
      // git upgrade could reword -- and, more importantly, from being mistaken
      // for a transport error and failing the whole input preparation.
      if (!(await fileExistsAtRef(tempDir, normalizedSha, normalizedPath))) {
        return null
      }

      const { stdout } = await execFileAsync(
        'git',
        ['show', `${normalizedSha}:${normalizedPath}`],
        {
          cwd: tempDir,
          timeout: configuredGitTimeoutMs(),
          env: gitNoPromptEnv()
        }
      )
      return stdout
    } catch (error) {
      // Fallback: if the probe itself failed and the error clearly means "no such
      // path", treat it as absent; otherwise surface it. A timed-out/killed
      // command is never "absent" (see fileExistsAtRef).
      if (!isKilledProcessError(error) && isGitMissingPathError(error)) {
        return null
      }
      throw error
    } finally {
      if (auth) {
        await auth.cleanup()
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

function gitNoPromptEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_TERMINAL_PROMPT: '0'
  }
}

/** True when `path` exists at `sha`. Uses `cat-file -e`, whose exit code (not a
 * message) reports presence; only the already-fetched commit is queried. */
async function fileExistsAtRef(cwd: string, sha: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['cat-file', '-e', `${sha}:${filePath}`], {
      cwd,
      timeout: configuredGitTimeoutMs(),
      env: gitNoPromptEnv()
    })
    return true
  } catch (error) {
    // A non-zero exit means the path is absent. A killed command (the timeout
    // above) means the probe never completed, which must NOT be read as
    // "absent": that would silently degrade a declared setup environment to an
    // unbootstrapped one. Surface it instead.
    if (isKilledProcessError(error)) {
      throw error
    }
    return false
  }
}

/** True when a subprocess was terminated by a signal rather than exiting. */
function isKilledProcessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const record = error as { killed?: unknown; signal?: unknown }
  return record.killed === true || (record.signal !== undefined && record.signal !== null)
}

function isGitMissingPathError(error: unknown): boolean {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : ''
  return (
    stderr.includes('does not exist in') ||
    stderr.includes('exists on disk, but not in') ||
    (stderr.includes('Path') && stderr.includes('does not exist')) ||
    stderr.includes('invalid object name')
  )
}
