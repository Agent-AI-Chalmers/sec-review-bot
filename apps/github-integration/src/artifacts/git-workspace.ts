import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

import { logWarn } from '../utils/logger.js'

const execFileAsync = promisify(execFile)
export const WORKSPACE_SNAPSHOT_TAR_NAME = 'workspace.snapshot.tar'

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
export function configuredGitTimeoutMs(
  configured = process.env[GIT_COMMAND_TIMEOUT_ENV]
): number {
  if (configured === undefined || configured.trim() === '') {
    return DEFAULT_GIT_COMMAND_TIMEOUT_MS
  }
  const parsed = Number.parseInt(configured, 10)
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    String(parsed) !== configured.trim()
  ) {
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

async function createGitAskPassAuth(
  git_auth_token: string
): Promise<GitAskPassAuth> {
  // Keep the installation token out of git argv; argv can be visible to other local processes.
  const authDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-auth-')
  )
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

async function runGitCommandCapture(
  workspace_path: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<string> {
  const configArgs = (options.config ?? []).flatMap((item) => ['-c', item])
  const { stdout } = await execFileAsync('git', [...configArgs, ...args], {
    cwd: workspace_path,
    timeout: options.timeout_ms ?? configuredGitTimeoutMs(),
    // A large diff can exceed the 1 MiB default execFile buffer, which would
    // fail preparation for exactly the changes this export exists to cover.
    maxBuffer: DIFF_MAX_OUTPUT_BYTES,
    env: {
      ...process.env,
      ...(options.env ?? {})
    }
  })
  return stdout
}

// Upper bound for a captured git diff. Preparation builds the diff in memory,
// so this is also the memory ceiling a single export may consume. The real large
// pull request measured against this code produced ~7.6 MB, so the bound leaves
// generous headroom while refusing pathological input instead of buffering it.
const DIFF_MAX_OUTPUT_BYTES = 128 * 1024 * 1024

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

async function requireWorkspaceCommand(
  command: string,
  args: string[]
): Promise<void> {
  try {
    await execFileAsync(command, args)
  } catch (error) {
    const cause =
      error instanceof Error && error.message ? ` ${error.message}` : ''
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
  await runGitCommand(workspace_path, [
    'config',
    'user.email',
    'sec-review-bot@localhost'
  ])
}

async function sanitizeMaterializedGitWorkspace(
  workspace_path: string
): Promise<void> {
  // The agent needs real git objects for diffs, but not remotes, credentials, or fetch metadata.
  await runGitCommand(workspace_path, ['remote', 'remove', 'origin']).catch(
    () => {}
  )
  await fs.rm(path.join(workspace_path, '.git', 'FETCH_HEAD'), { force: true })
  await fs.rm(path.join(workspace_path, '.git', 'ORIG_HEAD'), { force: true })
  await fs.rm(path.join(workspace_path, '.git', 'logs'), {
    recursive: true,
    force: true
  })
  await runGitCommand(workspace_path, [
    'reflog',
    'expire',
    '--expire=now',
    '--all'
  ]).catch(() => {})
  await runGitCommand(workspace_path, ['gc', '--prune=now'])
}

async function compactWorkspaceGitObjectsBeforeSnapshot(
  workspace_path: string
): Promise<void> {
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
    await initializeWorkspaceGitRepository({
      workspace_path: materialized_path
    })
    await runGitCommand(materialized_path, [
      'remote',
      'add',
      'origin',
      git_remote_url
    ])

    const auth = git_auth_token
      ? await createGitAskPassAuth(git_auth_token)
      : null
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
      throw new Error(
        'materializeWorkspaceFromRealGitHistory requires at least one ref.'
      )
    }
    await runGitCommand(materialized_path, ['checkout', '--detach', head_ref])
    // Fetching by SHA leaves no branch pointing at the fetched commits, and the
    // sanitize step prunes every unreachable object. Without a ref, the base
    // commit disappears and a later `git diff base...head` fails with an invalid
    // symmetric difference expression -- exactly the comparison pull-request
    // review depends on. Pin every requested ref under refs/sec-review/ so the
    // commits stay reachable; these refs carry no remote URL, credentials, or
    // fetch metadata, so the sanitize guarantee is preserved.
    for (const [index, ref] of refs.entries()) {
      await runGitCommand(materialized_path, [
        'update-ref',
        `refs/sec-review/input-${index}`,
        ref
      ])
    }
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
    .filter(
      (item, index, array) => item !== '' && array.indexOf(item) === index
    )

  if (normalizedRefs.length === 0) {
    throw new Error(
      'materializeWorkspaceWithCommitHistory requires at least one ref.'
    )
  }

  for (const ref of normalizedRefs) {
    if (ref.startsWith('-')) {
      throw new Error(
        'materializeWorkspaceWithCommitHistory refs must not start with "-".'
      )
    }
  }

  if (!git_remote_url || git_remote_url.trim() === '') {
    throw new Error(
      'materializeWorkspaceWithCommitHistory requires git_remote_url.'
    )
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

/**
 * Export the pull-request unified diff from a materialized workspace repository.
 *
 * The GitHub "list pull request files" API omits `patch` for part of a large
 * pull request even though the files themselves are returned: renames without
 * content changes, some additions, and individual files whose diff exceeds the
 * API's internal size budget. Callers that build the review's incremental patch
 * from that field therefore drop those changes silently. The workspace already
 * fetches base and every head commit, so the diff can be regenerated locally and
 * does not depend on which patches the API chose to return.
 */
/**
 * The `git diff` selectors every workspace export uses.
 *
 * The patch and the changed-file list must describe the same change set. Sharing these flags is
 * what guarantees that: a file the diff renders is a file the list reports, and vice versa.
 *
 * Three dots are required. GitHub's `pull_request.base.sha` is the base branch tip, not the point
 * where the pull request branched off, and it keeps moving as the base branch advances, so a
 * two-dot diff would render base-branch work as deletions. Three dots diff from the merge base,
 * which is also what the compare endpoint means by `base...head`.
 *
 * `--no-textconv` and `--no-ext-diff` close two independent ways for the diff text to stop being
 * the diff: a diff driver's textconv prints file content as text, and injected configuration can
 * set `diff.external`, which still fired under `--no-textconv`. `--binary` must NOT be added: it
 * emits the binary payload inline as base85 rather than a placeholder.
 */
const WORKSPACE_DIFF_ARGS = [
  'diff',
  '--no-color',
  '--no-textconv',
  '--no-ext-diff',
  '--find-renames'
] as const

const WORKSPACE_GIT_CONFIG = ['core.pager=cat', 'diff.noprefix=false']

function requireComparableRefs(
  base_sha: string,
  head_sha: string,
  caller: string
): void {
  for (const [label, value] of [
    ['base_sha', base_sha],
    ['head_sha', head_sha]
  ] as const) {
    if (value.trim() === '' || value.trim().startsWith('-')) {
      throw new Error(`${caller} requires a valid ${label}.`)
    }
  }
}

/**
 * Export the files the run's window touches, from the same repository and range as the patch.
 *
 * The API's file list is not usable for this: `GET /compare` caps its response at 300 files
 * (measured: a 340-file pull request returns exactly 300) and the pull request files endpoint
 * caps at 3000, while the diff has neither limit. Building `changed-files.json` from the API
 * therefore drops files the patch still contains, which is the window divergence this module
 * exists to prevent.
 */
export async function exportWorkspaceChangedFiles({
  workspace_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  base_sha: string
  head_sha: string
}): Promise<
  { path: string; status: string; additions: number; deletions: number }[]
> {
  requireComparableRefs(base_sha, head_sha, 'exportWorkspaceChangedFiles')
  const range = `${base_sha.trim()}...${head_sha.trim()}`

  const name_status = await runGitCommandCapture(
    workspace_path,
    [...WORKSPACE_DIFF_ARGS, '--name-status', range],
    { config: WORKSPACE_GIT_CONFIG }
  )
  const numstat = await runGitCommandCapture(
    workspace_path,
    [...WORKSPACE_DIFF_ARGS, '--numstat', range],
    { config: WORKSPACE_GIT_CONFIG }
  )

  return parseChangedFiles(name_status, numstat)
}

const GIT_STATUS_NAMES: Record<string, string> = {
  A: 'added',
  C: 'copied',
  D: 'removed',
  M: 'modified',
  R: 'renamed',
  T: 'changed',
  U: 'unmerged',
  X: 'unknown',
  B: 'broken'
}

/**
 * Combine `--name-status` and `--numstat` into one entry per file.
 *
 * `--numstat` reports binary files as `-`, which is not a line count; those become 0 so the list
 * stays numeric and the patch still carries the authoritative placeholder.
 */
function parseChangedFiles(
  name_status: string,
  numstat: string
): { path: string; status: string; additions: number; deletions: number }[] {
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstat.split('\n')) {
    if (line === '') continue
    const fields = line.split('\t')
    const added = fields[0]
    const removed = fields[1]
    const path = fields.at(-1)
    if (added === undefined || removed === undefined || path === undefined) {
      continue
    }
    counts.set(path, {
      additions: added === '-' ? 0 : Number.parseInt(added, 10) || 0,
      deletions: removed === '-' ? 0 : Number.parseInt(removed, 10) || 0
    })
  }

  const files: {
    path: string
    status: string
    additions: number
    deletions: number
  }[] = []
  for (const line of name_status.split('\n')) {
    if (line === '') continue
    const fields = line.split('\t')
    const code = fields[0]?.charAt(0) ?? ''
    const path = fields.at(-1)
    if (code === '' || path === undefined) continue
    const counts_for_path = counts.get(path) ?? { additions: 0, deletions: 0 }
    files.push({
      path,
      status: GIT_STATUS_NAMES[code] ?? 'unknown',
      additions: counts_for_path.additions,
      deletions: counts_for_path.deletions
    })
  }
  return files
}

/**
 * Export one entry per changed file, carrying that file's diff hunks.
 *
 * The suggestion anchoring needs a per-file `patch` to map a mitigation hunk onto PR-visible
 * lines. The API returns that field for most files but omits it for part of a large pull request,
 * and its file list is capped, so files the patch changes can end up unanchorable. Splitting the
 * workspace diff keeps the two in step: every file the diff touches appears here with its hunks.
 */
export async function exportWorkspaceFilesWithPatch({
  workspace_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  base_sha: string
  head_sha: string
}): Promise<
  {
    filename: string
    status: string
    additions: number
    deletions: number
    patch: string | null
  }[]
> {
  requireComparableRefs(base_sha, head_sha, 'exportWorkspaceFilesWithPatch')
  const range = `${base_sha.trim()}...${head_sha.trim()}`
  const entries = await exportWorkspaceChangedFiles({
    workspace_path,
    base_sha,
    head_sha
  })

  const per_file = await Promise.all(
    entries.map(async (entry) => {
      const patch = await runGitCommandCapture(
        workspace_path,
        [...WORKSPACE_DIFF_ARGS, range, '--', entry.path],
        { config: WORKSPACE_GIT_CONFIG }
      )
      return {
        filename: entry.path,
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        // A binary file's hunk is the "Binary files ... differ" placeholder, which carries no
        // anchorable lines; report it as absent rather than as a patch that cannot be mapped.
        patch: patch.includes('Binary files') ? null : patch
      }
    })
  )
  return per_file
}

export async function exportWorkspaceDiff({
  workspace_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  base_sha: string
  head_sha: string
}): Promise<string> {
  requireComparableRefs(base_sha, head_sha, 'exportWorkspaceDiff')

  // `--no-color` keeps the output machine-readable; `--find-renames` preserves
  // the rename relationship the API metadata also carries.
  //
  // Three dots (`base...head`) are required, and they are not interchangeable
  // with two. GitHub's `pull_request.base.sha` is the base branch tip, not the
  // point where the PR branched off, and it keeps moving as the base branch
  // advances. A two-dot diff compares the two commits as trees, so once the head
  // is behind the base it renders changes that only landed on the base branch as
  // if the PR deleted them. Three dots diff the merge base instead, which is the
  // change set the pull request actually introduces; it is also what GitHub's own
  // compare endpoint means by `base...head`, which the repository incremental
  // path already relies on. Computing the merge base through `...` keeps this to
  // one git invocation and matches GitHub's semantics exactly.
  //
  // This requires a merge base to exist, so the workspace must not be shallow.
  // Multi-ref materialization deliberately fetches without `--depth`; a shallow
  // workspace makes git fail with "no merge base" rather than emit a partial or
  // empty diff, which is the intended loud failure.
  //
  // `--no-textconv` and `--no-ext-diff` are both required, and they are not the
  // same guard: each closes a different way for the diff text to stop being the
  // diff. A binary file must never be rendered as text, and there are two
  // independent paths that can do it:
  //
  // - Textconv: a `diff=<driver>` attribute plus `diff.<driver>.textconv` makes
  //   git pipe file content through a command and diff the printed result. A
  //   binary file then shows up as text lines instead of the "Binary files ...
  //   differ" placeholder. `--no-textconv` disables it.
  // - External diff: `diff.external` (or `diff.<driver>.command`) replaces diff
  //   generation entirely with an arbitrary command's output. Measured here,
  //   this still fired under `--no-textconv`, because the external command never
  //   goes through the textconv path at all. `--no-ext-diff` disables it.
  //
  // Neither flag implies the other, and a repository or injected configuration
  // can supply either mechanism. `--binary` must NOT be added: it emits the
  // binary payload inline as base85, which measured larger than the default
  // placeholder and defeats the purpose of keeping binary content out of the diff.
  return runGitCommandCapture(
    workspace_path,
    [...WORKSPACE_DIFF_ARGS, `${base_sha.trim()}...${head_sha.trim()}`],
    { config: WORKSPACE_GIT_CONFIG }
  )
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
      [
        '-cf',
        tempPath,
        '-C',
        path.dirname(workspace_path),
        path.basename(workspace_path)
      ],
      { timeout: configuredGitTimeoutMs() }
    )
    await fs.rename(tempPath, tar_path)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}
