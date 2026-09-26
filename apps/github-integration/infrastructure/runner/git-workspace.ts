import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

import { logWarn } from '../../utils/logger.js'

const execFileAsync = promisify(execFile)
export const WORKSPACE_SNAPSHOT_TAR_NAME = 'workspace.snapshot.tar'

const GIT_FETCH_MAX_ATTEMPTS = 3
const GIT_FETCH_INITIAL_RETRY_DELAY_MS = 1_000
type Sleep = (delay_ms: number) => Promise<void>

// Materialization flow for real-history workspaces:
// 1. fetch only the requested refs in a temporary git repository;
// 2. checkout the target commit detached;
// 3. remove remotes, fetch metadata, reflogs, and unreachable objects;
// 4. move the sanitized git workspace into the agent input bundle.
// This keeps git diff/apply capabilities without handing the agent the fetch/auth workspace.

interface GitCommandOptions {
  config?: string[]
  env?: Record<string, string | undefined>
}

interface GitAskPassAuth {
  cleanup: () => Promise<void>
  config: string[]
  env: Record<string, string | undefined>
}

function shellSingleQuote (value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function createGitAskPassAuth (git_auth_token: string): Promise<GitAskPassAuth> {
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
    config: [
      'credential.helper=',
      'credential.interactive=never'
    ],
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

async function runGitCommand (
  workspace_path: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<void> {
  const configArgs = (options.config ?? []).flatMap((item) => ['-c', item])
  await execFileAsync('git', [...configArgs, ...args], {
    cwd: workspace_path,
    env: {
      ...process.env,
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_TERMINAL_PROMPT: '0',
      ...(options.env ?? {})
    }
  })
}

export async function retryGitFetch (
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

      const delay_ms = GIT_FETCH_INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1))
      logWarn('git_fetch_retry_scheduled', {
        attempt,
        next_attempt: attempt + 1,
        delay_ms
      })
      await sleep(delay_ms)
    }
  }
}

async function delay (delay_ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, delay_ms))
}

async function runGitFetchWithRetry (
  workspace_path: string,
  args: string[],
  options: GitCommandOptions
): Promise<void> {
  await retryGitFetch(() => runGitCommand(
    workspace_path,
    args,
    withConfiguredGitFetchProxy(options)
  ))
}

export function withConfiguredGitFetchProxy (
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

async function requireWorkspaceCommand (command: string, args: string[]): Promise<void> {
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

export async function verifyGitWorkspaceRuntime (): Promise<void> {
  await requireWorkspaceCommand('git', ['--version'])
  await requireWorkspaceCommand('tar', ['--version'])
}

async function initializeWorkspaceGitRepository ({
  workspace_path
}: {
  workspace_path: string
}): Promise<void> {
  await fs.mkdir(workspace_path, { recursive: true })
  await runGitCommand(workspace_path, ['init'])
  await runGitCommand(workspace_path, ['config', 'user.name', 'sec-review-bot'])
  await runGitCommand(workspace_path, ['config', 'user.email', 'sec-review-bot@localhost'])
}

async function commitWorkspaceSnapshot ({
  workspace_path,
  source_ref
}: {
  workspace_path: string
  source_ref: string
}): Promise<void> {
  await runGitCommand(workspace_path, ['add', '--all', '.'])
  await runGitCommand(workspace_path, [
    'commit',
    '--allow-empty',
    '-m',
    `chore: initialize workspace snapshot (${source_ref})`
  ])
}

async function sanitizeMaterializedGitWorkspace (workspace_path: string): Promise<void> {
  // The agent needs real git objects for diffs, but not remotes, credentials, or fetch metadata.
  await runGitCommand(workspace_path, ['remote', 'remove', 'origin']).catch(() => {})
  await fs.rm(path.join(workspace_path, '.git', 'FETCH_HEAD'), { force: true })
  await fs.rm(path.join(workspace_path, '.git', 'ORIG_HEAD'), { force: true })
  await fs.rm(path.join(workspace_path, '.git', 'logs'), { recursive: true, force: true })
  await runGitCommand(workspace_path, ['reflog', 'expire', '--expire=now', '--all']).catch(() => {})
  await runGitCommand(workspace_path, ['gc', '--prune=now'])
}

async function compactWorkspaceGitObjectsBeforeSnapshot (workspace_path: string): Promise<void> {
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

async function replaceWorkspaceWithMaterializedRepository ({
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

async function materializeWorkspaceFromRealGitHistory ({
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
  const materialized_path = await fs.mkdtemp(path.join(path.dirname(workspace_path), '.workspace-fetch-'))

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
        auth
          ? { config: auth.config, env: auth.env }
          : {}
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

export async function materializeWorkspaceWithCommitHistory ({
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

export async function initializeWorkspaceAsGitRepository ({
  workspace_path,
  source_ref = 'snapshot'
}: {
  workspace_path: string
  source_ref?: string
}): Promise<void> {
  await initializeWorkspaceGitRepository({ workspace_path })
  await commitWorkspaceSnapshot({
    workspace_path,
    source_ref
  })
}

export async function createWorkspaceSnapshotTar ({
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
    await execFileAsync('tar', [
      '-cf',
      tempPath,
      '-C',
      path.dirname(workspace_path),
      path.basename(workspace_path)
    ])
    await fs.rename(tempPath, tar_path)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}
