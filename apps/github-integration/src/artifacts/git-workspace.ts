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

/**
 * Name a requested workspace ref by the role it plays in the review window.
 *
 * Only two roles are worth a name: the commit under review (`head`, always the last ref and the
 * one the workspace checks out) and the window's start (`base`). The window start cannot be read
 * off the array: a pull request passes its own base first and the review window's base second,
 * and on `synchronize` those are different commits. So the caller states it, and a ref only
 * earns `base` by matching that identity. Every other ref exists only to keep its commit
 * reachable after sanitize and is numbered.
 */
function secReviewInputRefName(
  ref: string,
  index: number,
  ref_count: number,
  window_base_sha: string | undefined
): string {
  if (index === ref_count - 1) return 'head'
  if (window_base_sha !== undefined && ref === window_base_sha) return 'base'
  return `pinned-${index}`
}

async function materializeWorkspaceFromRealGitHistory({
  workspace_path,
  git_remote_url,
  refs,
  window_base_sha,
  git_auth_token
}: {
  workspace_path: string
  git_remote_url: string
  refs: string[]
  window_base_sha?: string
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
    //
    // The head role is positional: it is the last ref, which is what `checkout` above
    // already relies on. The base role is not -- see secReviewInputRefName.
    for (const [index, ref] of refs.entries()) {
      await runGitCommand(materialized_path, [
        'update-ref',
        `refs/sec-review/${secReviewInputRefName(ref, index, refs.length, window_base_sha)}`,
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
  window_base_sha,
  git_remote_url,
  git_auth_token
}: {
  workspace_path: string
  refs: string[]
  // The commit the review window starts at, when it differs from the last ref's history
  // parent. Callers must pass it rather than let the workspace infer it: pull request
  // materialization puts the pull request's own base before the window's.
  window_base_sha?: string
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
  const normalizedWindowBaseSha = window_base_sha?.trim() || undefined
  if (
    normalizedWindowBaseSha !== undefined &&
    !normalizedRefs.includes(normalizedWindowBaseSha)
  ) {
    // A window base that is not among the refs never gets pinned, so it could be
    // pruned by sanitize and the base ref would be absent while callers assume it exists.
    throw new Error(
      'materializeWorkspaceWithCommitHistory window_base_sha must be one of refs.'
    )
  }
  await materializeWorkspaceFromRealGitHistory({
    workspace_path,
    git_remote_url: git_remote_url.trim(),
    refs: normalizedRefs,
    ...(normalizedWindowBaseSha
      ? { window_base_sha: normalizedWindowBaseSha }
      : {}),
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
/** The scan scope's change vocabulary, as the contract schema defines it. */
export type ChangedFileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed'

/**
 * Project git's diff letters onto the contract's status vocabulary.
 *
 * Git and the compare API are upstream representations; neither is the domain value. Only letters
 * that map to a contract status are listed: `U` (unmerged) and `B` (broken) describe workspace
 * states with no scan-scope meaning, so an unlisted letter is rejected rather than guessed at.
 *
 * `D` becomes `deleted`, not the compare API's `removed`, because `deleted` is the value the rest
 * of this repository uses -- discovery skips exactly that status.
 */
const GIT_STATUS_NAMES: Record<string, ChangedFileStatus> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type_changed'
}

/**
 * Read `--name-status -z` output: `<STATUS>\0<path>\0`, with an extra path for a rename or copy.
 *
 * `-z` writes paths as raw bytes with no quoting or escaping. The human-readable form quotes any
 * path containing a tab, quote, or newline and octal-escapes non-ASCII bytes, which makes the
 * path unusable as a key unless this module re-implements git's quoting rules.
 */
function parseNameStatusZ(output: string): {
  path: string
  status: ChangedFileStatus
  previous_path: string | null
}[] {
  const fields = output.split('\0')
  const entries: {
    path: string
    status: ChangedFileStatus
    previous_path: string | null
  }[] = []
  let index = 0
  while (index + 1 < fields.length) {
    const raw_status = fields[index] ?? ''
    if (raw_status === '') break
    index += 1
    const code = raw_status.charAt(0)
    const status = GIT_STATUS_NAMES[code]
    if (status === undefined) {
      throw new Error(
        `workspace diff reported git status '${code}', which has no scan-scope meaning`
      )
    }
    if (code === 'R' || code === 'C') {
      const previous_path = fields[index] ?? ''
      const path = fields[index + 1] ?? ''
      index += 2
      if (path !== '') entries.push({ path, status, previous_path })
      continue
    }
    const path = fields[index] ?? ''
    index += 1
    if (path !== '') entries.push({ path, status, previous_path: null })
  }
  return entries
}

/**
 * Read `--numstat -z` output.
 *
 * A record starts with `<added>\t<deleted>\t`. For an ordinary file the path follows that third
 * field on the same line and the record ends at the next NUL:
 *
 *     <added>\t<deleted>\t<path>\0
 *
 * A rename or copy leaves the third field empty and puts both paths in their own NUL-terminated
 * fields:
 *
 *     <added>\t<deleted>\t\0<old>\0<new>\0
 *
 * Only the new path is keyed, because that is the path the diff and the file list use. A binary
 * file reports `-` for both counts, which is not a line count; those become 0 so the list stays
 * numeric while the patch keeps the authoritative placeholder.
 */
function parseNumstatZ(
  output: string
): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  const fields = output.split('\0')
  let index = 0
  while (index < fields.length) {
    const record = fields[index] ?? ''
    index += 1
    if (record === '') continue

    // Split at the first two tabs only: `-z` disables quoting, so it also stops escaping tabs
    // inside the path itself. Splitting on every tab would truncate a path like `file\tname.txt`
    // to `file`, and its counts would never match the name-status entry.
    const first_tab = record.indexOf('\t')
    const second_tab =
      first_tab === -1 ? -1 : record.indexOf('\t', first_tab + 1)
    const added = first_tab === -1 ? '' : record.slice(0, first_tab)
    const removed =
      second_tab === -1 ? '' : record.slice(first_tab + 1, second_tab)
    const inline_path = second_tab === -1 ? '' : record.slice(second_tab + 1)
    const counts_for_file = {
      additions: added === '-' ? 0 : Number.parseInt(added, 10) || 0,
      deletions: removed === '-' ? 0 : Number.parseInt(removed, 10) || 0
    }

    if (inline_path !== '') {
      counts.set(inline_path, counts_for_file)
      continue
    }
    // Rename or copy: the next two NUL fields are the old and new paths.
    const renamed_from = fields[index] ?? ''
    const renamed_to = fields[index + 1] ?? ''
    index += 2
    if (renamed_from === '' && renamed_to === '') continue
    counts.set(renamed_to, counts_for_file)
  }
  return counts
}

export async function exportWorkspaceChangedFiles({
  workspace_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  base_sha: string
  head_sha: string
}): Promise<
  {
    path: string
    status: ChangedFileStatus
    previous_path: string | null
    additions: number
    deletions: number
  }[]
> {
  requireComparableRefs(base_sha, head_sha, 'exportWorkspaceChangedFiles')
  const range = `${base_sha.trim()}...${head_sha.trim()}`
  const name_status = await runGitCommandCapture(
    workspace_path,
    [...WORKSPACE_DIFF_ARGS, '--name-status', '-z', range],
    { config: WORKSPACE_GIT_CONFIG }
  )
  const numstat = await runGitCommandCapture(
    workspace_path,
    [...WORKSPACE_DIFF_ARGS, '--numstat', '-z', range],
    { config: WORKSPACE_GIT_CONFIG }
  )
  const counts = parseNumstatZ(numstat)
  return parseNameStatusZ(name_status).map((entry) => ({
    path: entry.path,
    status: entry.status,
    previous_path: entry.previous_path,
    ...(counts.get(entry.path) ?? { additions: 0, deletions: 0 })
  }))
}

/**
 * List the commits in `base..head`, oldest first.
 *
 * The compare API paginates its `commits` array: without `per_page` it returns 250 per page, and
 * reading further pages is a loop this caller does not want. The workspace already holds the
 * history, so `git rev-list` answers the same question in one call with no page size and no cap.
 * This is also what the local materializer does, so both producers name the window's commits the
 * same way.
 */
export async function exportWorkspaceCommits({
  workspace_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  base_sha: string
  head_sha: string
}): Promise<string[]> {
  requireComparableRefs(base_sha, head_sha, 'exportWorkspaceCommits')
  // Two dots, not three: the window is the commits reachable from head and not from base, which
  // is the same set the diff renders, expressed in commit terms.
  const output = await runGitCommandCapture(
    workspace_path,
    ['rev-list', '--reverse', `${base_sha.trim()}..${head_sha.trim()}`],
    { config: WORKSPACE_GIT_CONFIG }
  )
  return output.split('\n').filter((sha) => sha !== '')
}

/**
 * Every artifact a run needs from one workspace comparison.
 *
 * The patch, the file list, and the per-file slices must describe the same change set, and
 * computing them together makes that structural rather than a convention. The work is a fixed
 * number of git invocations regardless of file count, which matters because a pull request can
 * carry thousands of files.
 */
export async function exportWorkspaceWindow({
  workspace_path,
  base_sha,
  head_sha
}: {
  workspace_path: string
  base_sha: string
  head_sha: string
}): Promise<{
  patch: string
  files: {
    filename: string
    status: ChangedFileStatus
    previous_path: string | null
    additions: number
    deletions: number
    patch: string | null
  }[]
  commit_shas: string[]
}> {
  requireComparableRefs(base_sha, head_sha, 'exportWorkspaceWindow')
  const range = `${base_sha.trim()}...${head_sha.trim()}`

  const [entries, patch, commit_shas] = await Promise.all([
    exportWorkspaceChangedFiles({ workspace_path, base_sha, head_sha }),
    exportWorkspaceDiff({ workspace_path, base_sha, head_sha }),
    exportWorkspaceCommits({ workspace_path, base_sha, head_sha })
  ])
  const ordered_paths = await runGitCommandCapture(
    workspace_path,
    [...WORKSPACE_DIFF_ARGS, '--name-only', '-z', range],
    { config: WORKSPACE_GIT_CONFIG }
  ).then((output) => output.split('\0').filter((path) => path !== ''))

  // The diff's sections appear in the same order as `--name-only -z`, so the paths pair with the
  // sections positionally. Reading the paths from git in raw form avoids parsing the human
  // `diff --git` header, which quotes any path containing a tab, quote, or non-ASCII byte.
  const sections = splitDiffIntoSections(patch)
  if (sections.length !== ordered_paths.length) {
    // Pairing is positional, so a mismatch means the assumption no longer holds and every patch
    // would be dropped silently -- the failure this whole export exists to prevent. Fail loudly
    // instead of returning a suggestion set that cannot anchor anything.
    throw new Error(
      `workspace diff sections (${sections.length}) do not match changed files (${ordered_paths.length})`
    )
  }
  const patch_by_path = new Map<string, string>()
  ordered_paths.forEach((file_path, index) => {
    const section = sections[index]
    if (section !== undefined) patch_by_path.set(file_path, section)
  })

  return {
    patch,
    commit_shas,
    files: entries.map((entry) => {
      const file_patch = patch_by_path.get(entry.path)
      return {
        filename: entry.path,
        status: entry.status,
        previous_path: entry.previous_path,
        additions: entry.additions,
        deletions: entry.deletions,
        // A binary file's hunk is the "Binary files ... differ" placeholder, which carries no
        // anchorable lines; report it as absent rather than as a patch that cannot be mapped.
        patch:
          file_patch === undefined || file_patch.includes('Binary files')
            ? null
            : file_patch
      }
    })
  }
}

/**
 * Split a unified diff at each `diff --git` line, keeping the line with its section.
 *
 * A diff with no changes is the empty string, which must produce no sections: `''.split('\n')`
 * yields one empty line, and counting that as a section would report a change where there is
 * none.
 */
function splitDiffIntoSections(diff: string): string[] {
  if (diff === '') return []
  const sections: string[] = []
  let current: string[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) sections.push(current.join('\n'))
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n'))
  return sections
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
