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

export interface IssueContext {
  action: string
  repo_name: string
  repo_full_name: string
  owner_login: string
  sender_login: string | undefined
  default_branch: string
  issue_number: number
  issue_title: string
  issue_body: string | null
  issue_author: string | undefined
  issue_state: string
  labels: string[]
  html_url: string
  api_url: string
  comments_url: string
  is_pull_request: boolean
}

export class IssueContextExtractionError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'IssueContextExtractionError'
  }
}

interface LinkedPullRequestRef {
  event: 'cross-referenced'
  pull_request_number: number
}

interface LinkedPullRequest {
  number: number
  title: string
  body: string | null
  state: string
  author_login: string | null
  html_url: string
  api_url: string
  base_ref: string | null
  head_ref: string | null
}

function requireText (value: string, label: string): void {
  if (value.trim() === '') {
    throw new IssueContextExtractionError(`Issue webhook payload is missing ${label}.`)
  }
}

function requirePositiveInteger (value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new IssueContextExtractionError(`Issue webhook payload is missing ${label}.`)
  }
}

function requireIssueContext (context: IssueContext): IssueContext {
  requireText(context.repo_name, 'repository.name')
  requireText(context.repo_full_name, 'repository.full_name')
  requireText(context.owner_login, 'repository.owner.login')
  requireText(context.default_branch, 'repository.default_branch')
  requirePositiveInteger(context.issue_number, 'issue.number')
  requireText(context.issue_title, 'issue.title')
  requireText(context.issue_state, 'issue.state')
  return context
}

export function extractIssueContext (payload: unknown): IssueContext {
  const rawPayload = asRecord(payload)
  const repository = asRecord(rawPayload.repository)
  const repositoryOwner = asRecord(repository.owner)
  const sender = asRecord(rawPayload.sender)
  const issue = asRecord(rawPayload.issue)
  const issueUser = asRecord(issue.user)
  return requireIssueContext({
    action: asString(rawPayload.action),
    repo_name: asString(repository.name),
    repo_full_name: asString(repository.full_name),
    owner_login: asString(repositoryOwner.login),
    sender_login: asString(sender.login, '').trim() || undefined,
    default_branch: asString(repository.default_branch),

    issue_number: asNumber(issue.number),
    issue_title: asString(issue.title),
    issue_body: asString(issue.body, '').trim() || null,
    issue_author: asString(issueUser.login, '').trim() || undefined,
    issue_state: asString(issue.state),
    labels: Array.isArray(issue.labels)
      ? issue.labels
        .map((label) => typeof label?.name === 'string' ? label.name : null)
        .filter((label): label is string => Boolean(label))
      : [],

    html_url: asString(issue.html_url),
    api_url: asString(issue.url),
    comments_url: asString(issue.comments_url),
    is_pull_request: Boolean(issue.pull_request)
  })
}

export async function getIssueDefaultBranchHeadSha (octokit: GitHubAppOctokit, issue: IssueContext): Promise<string> {
  const response = await octokit.rest.repos.getBranch({
    owner: issue.owner_login,
    repo: issue.repo_name,
    branch: issue.default_branch
  })

  return response.data.commit.sha
}

function isSameRepositoryPullRequestSource (
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

async function listTimelineCrossReferencedPullRequestRefs (
  octokit: GitHubAppOctokit,
  issue: IssueContext
): Promise<LinkedPullRequestRef[]> {
  const refs: LinkedPullRequestRef[] = []
  const seen = new Set<number>()
  let page = 1

  while (true) {
    const response = await octokit.rest.issues.listEventsForTimeline({
      owner: issue.owner_login,
      repo: issue.repo_name,
      issue_number: issue.issue_number,
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

      const pullRequest = asRecord(source_issue.pull_request)
      if (!pullRequest || Object.keys(pullRequest).length === 0) {
        continue
      }

      if (!isSameRepositoryPullRequestSource(source_issue, { owner_login: issue.owner_login, repo_name: issue.repo_name })) {
        continue
      }

      const pr_number = asNumber(source_issue.number)
      if (!Number.isInteger(pr_number) || pr_number <= 0 || seen.has(pr_number)) {
        continue
      }

      seen.add(pr_number)
      refs.push({
        event: 'cross-referenced',
        pull_request_number: pr_number
      })
    }

    if (response.data.length < 100) {
      break
    }

    page += 1
  }

  return refs
}

export async function fetchTimelineLinkedPullRequests (
  octokit: GitHubAppOctokit,
  issue: IssueContext
): Promise<{
  source: 'issue-timeline-cross-references'
  refs: LinkedPullRequestRef[]
  pull_requests: LinkedPullRequest[]
}> {
  const refs = await listTimelineCrossReferencedPullRequestRefs(octokit, issue)
  const pull_requests: LinkedPullRequest[] = []
  const seen = new Set<number>()

  let page = 1
  while (true) {
    const response = await octokit.rest.issues.listEventsForTimeline({
      owner: issue.owner_login,
      repo: issue.repo_name,
      issue_number: issue.issue_number,
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
      const pullRequest = asRecord(source_issue.pull_request)
      if (!pullRequest || Object.keys(pullRequest).length === 0) {
        continue
      }
      if (!isSameRepositoryPullRequestSource(source_issue, { owner_login: issue.owner_login, repo_name: issue.repo_name })) {
        continue
      }

      const number = asNumber(source_issue.number)
      if (!Number.isInteger(number) || number <= 0 || seen.has(number)) {
        continue
      }

      seen.add(number)
      pull_requests.push({
        number,
        title: asString(source_issue.title),
        body: asString(source_issue.body, '').trim() || null,
        state: asString(source_issue.state),
        author_login: asString(asRecord(source_issue.user).login, '').trim() || null,
        html_url: asString(source_issue.html_url),
        api_url: asString(source_issue.url),
        base_ref: asString(asRecord(pullRequest.base).ref, '').trim() || null,
        head_ref: asString(asRecord(pullRequest.head).ref, '').trim() || null
      })
    }

    if (response.data.length < 100) {
      break
    }

    page += 1
  }

  return {
    source: 'issue-timeline-cross-references',
    refs,
    pull_requests
  }
}
