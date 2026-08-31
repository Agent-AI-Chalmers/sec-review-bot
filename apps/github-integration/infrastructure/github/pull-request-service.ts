import type { GitHubAppOctokit } from './octokit.js'

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord (value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asString (value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber (value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean (value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export interface PullRequestContext {
  action: string
  previous_head_sha: string | null
  repo_name: string
  repo_full_name: string
  owner_login: string
  sender_login: string | null
  pr_number: number
  pr_title: string
  pr_body: string | null
  pr_author: string | null
  is_draft: boolean
  base_ref: string
  base_sha: string
  head_ref: string
  head_sha: string
  commits: number
  changed_files: number
  additions: number
  deletions: number
  html_url: string
  api_url: string
  commits_url: string
  review_comments_url: string
  comments_url: string
  issue_url: string
  head_repo_full_name: string | null
  base_repo_full_name: string | null
  from_fork: boolean
}

export class PullRequestContextExtractionError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'PullRequestContextExtractionError'
  }
}

export interface PullRequestFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  blob_url?: string | null
  raw_url?: string | null
  patch?: string | null
}

export interface PullRequestFileSummary {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  blob_url: string | null
  raw_url: string | null
  patch: string | null
}

interface LinkedIssueRef {
  event: 'cross-referenced'
  issue_number: number
}

interface LinkedIssue {
  number: number
  title: string
  body: string | null
  state: string
  author_login: string | null
  labels: string[]
  html_url: string
  api_url: string
}

function buildPullRequestContextFromRaw (rawPayload: Record<string, unknown>): PullRequestContext {
  const repository = asRecord(rawPayload.repository)
  const repositoryOwner = asRecord(repository.owner)
  const sender = asRecord(rawPayload.sender)
  const pullRequest = asRecord(rawPayload.pull_request)
  const pullRequestUser = asRecord(pullRequest.user)
  const pullRequestBase = asRecord(pullRequest.base)
  const pullRequestHead = asRecord(pullRequest.head)
  const pullRequestHeadRepo = asRecord(pullRequestHead.repo)
  const pullRequestBaseRepo = asRecord(pullRequestBase.repo)

  const head_repo_full_name = asString(pullRequestHeadRepo.full_name, '').trim() || null
  const base_repo_full_name = asString(pullRequestBaseRepo.full_name, '').trim() || null

  return requirePullRequestContext({
    action: asString(rawPayload.action),
    previous_head_sha: asString(rawPayload.before, '').trim() || null,
    repo_name: asString(repository.name),
    repo_full_name: asString(repository.full_name),
    owner_login: asString(repositoryOwner.login),
    sender_login: asString(sender.login, '').trim() || null,

    pr_number: asNumber(pullRequest.number),
    pr_title: asString(pullRequest.title),
    pr_body: asString(pullRequest.body, '').trim() || null,
    pr_author: asString(pullRequestUser.login, '').trim() || null,
    is_draft: asBoolean(pullRequest.draft),

    base_ref: asString(pullRequestBase.ref),
    base_sha: asString(pullRequestBase.sha),
    head_ref: asString(pullRequestHead.ref),
    head_sha: asString(pullRequestHead.sha),

    commits: asNumber(pullRequest.commits),
    changed_files: asNumber(pullRequest.changed_files),
    additions: asNumber(pullRequest.additions),
    deletions: asNumber(pullRequest.deletions),

    html_url: asString(pullRequest.html_url),
    api_url: asString(pullRequest.url),
    commits_url: asString(pullRequest.commits_url),
    review_comments_url: asString(pullRequest.review_comments_url),
    comments_url: asString(pullRequest.comments_url),
    issue_url: asString(pullRequest.issue_url),

    head_repo_full_name,
    base_repo_full_name,
    from_fork: head_repo_full_name !== base_repo_full_name
  })
}

function requireText (value: string, label: string): void {
  if (value.trim() === '') {
    throw new PullRequestContextExtractionError(`Pull request webhook payload is missing ${label}.`)
  }
}

function requirePositiveInteger (value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PullRequestContextExtractionError(`Pull request webhook payload is missing ${label}.`)
  }
}

function requirePullRequestContext (context: PullRequestContext): PullRequestContext {
  requireText(context.repo_name, 'repository.name')
  requireText(context.repo_full_name, 'repository.full_name')
  requireText(context.owner_login, 'repository.owner.login')
  requirePositiveInteger(context.pr_number, 'pull_request.number')
  requireText(context.pr_title, 'pull_request.title')
  requireText(context.base_ref, 'pull_request.base.ref')
  requireText(context.base_sha, 'pull_request.base.sha')
  requireText(context.head_ref, 'pull_request.head.ref')
  requireText(context.head_sha, 'pull_request.head.sha')
  return context
}

export function extractPullRequestContext (payload: unknown): PullRequestContext {
  return buildPullRequestContextFromRaw(asRecord(payload))
}

export async function getPullRequestContext (
  octokit: GitHubAppOctokit,
  { owner_login, repo_name, pr_number }: { owner_login: string, repo_name: string, pr_number: number }
): Promise<PullRequestContext> {
  const response = await octokit.rest.pulls.get({
    owner: owner_login,
    repo: repo_name,
    pull_number: pr_number
  })

  return buildPullRequestContextFromRaw({
    action: 'manual_review',
    before: null,
    repository: {
      name: repo_name,
      full_name: asString(asRecord(asRecord(response.data.base).repo).full_name) || `${owner_login}/${repo_name}`,
      owner: {
        login: asString(asRecord(asRecord(asRecord(response.data.base).repo).owner).login) || owner_login
      }
    },
    sender: null,
    pull_request: response.data
  })
}

export async function listPullRequestFiles (
  octokit: GitHubAppOctokit,
  { owner_login, repo_name, pr_number }: { owner_login: string, repo_name: string, pr_number: number }
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = []
  let page = 1

  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner: owner_login,
      repo: repo_name,
      pull_number: pr_number,
      per_page: 100,
      page
    })

    files.push(...response.data)

    if (response.data.length < 100) {
      break
    }

    page += 1
  }

  return files
}

export async function listFilesChangedBetweenCommits (
  octokit: GitHubAppOctokit,
  { owner_login, repo_name, previous_head_sha, current_head_sha }: {
    owner_login: string
    repo_name: string
    previous_head_sha: string
    current_head_sha: string
  }
): Promise<PullRequestFile[]> {
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: owner_login,
    repo: repo_name,
    basehead: `${previous_head_sha}...${current_head_sha}`
  })

  return response.data.files ?? []
}

export function summarizePullRequestFiles (files: PullRequestFile[]): PullRequestFileSummary[] {
  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: file.blob_url ?? null,
    raw_url: file.raw_url ?? null,
    patch: file.patch ?? null
  }))
}

function isSameRepositoryIssueSource (
  source_issue: Record<string, unknown>,
  context: {
    owner_login: string
    repo_name: string
  }
): boolean {
  const { owner_login, repo_name } = context
  const repositoryUrl = asString(source_issue.repository_url).trim().toLowerCase()
  if (!repositoryUrl) {
    return false
  }
  return repositoryUrl.endsWith(`/repos/${owner_login.toLowerCase()}/${repo_name.toLowerCase()}`)
}

async function listTimelineCrossReferencedIssueRefs (
  octokit: GitHubAppOctokit,
  pr: PullRequestContext
): Promise<LinkedIssueRef[]> {
  const refs: LinkedIssueRef[] = []
  const seen = new Set<number>()
  let page = 1

  while (true) {
    const response = await octokit.rest.issues.listEventsForTimeline({
      owner: pr.owner_login,
      repo: pr.repo_name,
      issue_number: pr.pr_number,
      per_page: 100,
      page
    })

    for (const rawEvent of response.data) {
      const timelineEvent = asRecord(rawEvent)
      if (asString(timelineEvent.event) !== 'cross-referenced') {
        continue
      }

      const source = asRecord(timelineEvent.source)
      const source_issue = asRecord(source.issue)
      if (!source_issue || Object.keys(source_issue).length === 0) {
        continue
      }

      if (source_issue.pull_request) {
        continue
      }

      if (!isSameRepositoryIssueSource(source_issue, { owner_login: pr.owner_login, repo_name: pr.repo_name })) {
        continue
      }

      const issue_number = asNumber(source_issue.number)
      if (!Number.isInteger(issue_number) || issue_number <= 0 || seen.has(issue_number)) {
        continue
      }

      seen.add(issue_number)
      refs.push({
        event: 'cross-referenced',
        issue_number
      })
    }

    if (response.data.length < 100) {
      break
    }

    page += 1
  }

  return refs
}

export async function fetchTimelineLinkedIssues (
  octokit: GitHubAppOctokit,
  pr: PullRequestContext
): Promise<{
  source: 'pr-timeline-cross-references'
  refs: LinkedIssueRef[]
  issues: LinkedIssue[]
}> {
  const refs = await listTimelineCrossReferencedIssueRefs(octokit, pr)

  if (refs.length === 0) {
    return {
      source: 'pr-timeline-cross-references',
      refs: [],
      issues: []
    }
  }

  const issues: LinkedIssue[] = []

  for (const ref of refs) {
    const response = await octokit.rest.issues.get({
      owner: pr.owner_login,
      repo: pr.repo_name,
      issue_number: ref.issue_number
    })

    const issue = asRecord(response.data)

    if (issue.pull_request) {
      continue
    }

    const user = asRecord(issue.user)
    const labels = Array.isArray(issue.labels)
      ? issue.labels
        .map((label) => asString(asRecord(label).name, '').trim())
        .filter(Boolean)
      : []

    issues.push({
      number: asNumber(issue.number),
      title: asString(issue.title),
      body: asString(issue.body, '').trim() || null,
      state: asString(issue.state),
      author_login: asString(user.login, '').trim() || null,
      labels,
      html_url: asString(issue.html_url),
      api_url: asString(issue.url)
    })
  }

  return {
    source: 'pr-timeline-cross-references',
    refs,
    issues
  }
}
