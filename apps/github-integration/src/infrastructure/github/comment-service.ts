import type { GitHubAppOctokit, GitHubPullRequestReview } from './octokit.js'
import { asErrorWithResponse } from '../../utils/error-utils.js'

export type ReviewCommentSide = 'LEFT' | 'RIGHT'
export type PullRequestReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'

interface CreateIssueCommentArgs {
  owner_login: string
  repo_name: string
  issue_number: number
  body: string
}

interface CreateIssueCommentUnlessMarkerExistsArgs extends CreateIssueCommentArgs {
  marker: string
  assert_publication_claim: () => Promise<void>
}

interface IssueCommentSummary {
  id: number
  body?: string | null
  html_url: string
  user?: {
    type?: string
  } | null
}

export interface PullRequestReviewCommentInput {
  path: string
  body: string
  line: number
  side: ReviewCommentSide
  start_line?: number
  start_side?: ReviewCommentSide
}

interface CreatePullRequestReviewArgs {
  owner_login: string
  repo_name: string
  pr_number: number
  commit_id: string
  body: string
  event?: PullRequestReviewEvent
  comments: PullRequestReviewCommentInput[]
}

interface CreatePullRequestReviewUnlessMarkerExistsArgs extends CreatePullRequestReviewArgs {
  marker: string
  assert_publication_claim: () => Promise<void>
}

function isOwnPullRequestApprovalError(error: unknown): boolean {
  const errorInfo = asErrorWithResponse(error)
  if (errorInfo.response?.status !== 422) {
    return false
  }

  const responseErrors = errorInfo.response.data?.errors
  const errorTexts = [
    errorInfo.response.data?.message,
    errorInfo.message,
    ...(Array.isArray(responseErrors)
      ? responseErrors.map((item) => {
          if (typeof item === 'object' && item !== null && 'message' in item) {
            return String(item.message)
          }
          return String(item)
        })
      : [String(responseErrors ?? '')])
  ].filter((item): item is string => typeof item === 'string' && item.trim() !== '')

  return errorTexts.some((item) => {
    const text = item.toLowerCase()
    return text.includes('approve') && text.includes('own pull request')
  })
}

async function createIssueComment(
  octokit: GitHubAppOctokit,
  { owner_login, repo_name, issue_number, body }: CreateIssueCommentArgs,
  assertPublicationClaim: () => Promise<void>
): Promise<{ id: number; html_url: string }> {
  await assertPublicationClaim()
  const response = await octokit.rest.issues.createComment({
    owner: owner_login,
    repo: repo_name,
    issue_number: issue_number,
    body
  })

  return response.data
}

async function findIssueCommentByMarker(
  octokit: GitHubAppOctokit,
  {
    owner_login,
    repo_name,
    issue_number,
    marker
  }: Omit<CreateIssueCommentUnlessMarkerExistsArgs, 'body' | 'assert_publication_claim'>
): Promise<IssueCommentSummary | null> {
  let page = 1

  while (true) {
    const response = await octokit.rest.issues.listComments({
      owner: owner_login,
      repo: repo_name,
      issue_number: issue_number,
      per_page: 100,
      page
    })

    if (response.data.length === 0) {
      return null
    }

    for (const comment of response.data) {
      if (comment.user?.type !== 'Bot') {
        continue
      }
      if (typeof comment.body === 'string' && comment.body.includes(marker)) {
        return comment
      }
    }

    if (response.data.length < 100) {
      return null
    }

    page += 1
  }
}

export async function createIssueCommentUnlessMarkerExists(
  octokit: GitHubAppOctokit,
  {
    owner_login,
    repo_name,
    issue_number,
    body,
    marker,
    assert_publication_claim
  }: CreateIssueCommentUnlessMarkerExistsArgs
): Promise<{ id: number; html_url: string; reused: boolean }> {
  const existing = await findIssueCommentByMarker(octokit, {
    owner_login,
    repo_name,
    issue_number,
    marker
  })

  if (existing !== null) {
    // Summary comments are audit records; an existing marker means this run already published one.
    return {
      id: existing.id,
      html_url: existing.html_url,
      reused: true
    }
  }

  const created = await createIssueComment(
    octokit,
    { owner_login, repo_name, issue_number, body },
    assert_publication_claim
  )
  return {
    ...created,
    reused: false
  }
}

async function createPullRequestReview(
  octokit: GitHubAppOctokit,
  {
    owner_login,
    repo_name,
    pr_number,
    commit_id,
    body,
    event = 'COMMENT',
    comments,
    assert_publication_claim
  }: CreatePullRequestReviewArgs & { assert_publication_claim: () => Promise<void> }
): Promise<{ id: number; html_url: string; state: string }> {
  const request = {
    owner: owner_login,
    repo: repo_name,
    pull_number: pr_number,
    commit_id: commit_id,
    body,
    event,
    comments
  }

  let response: Awaited<ReturnType<GitHubAppOctokit['rest']['pulls']['createReview']>>
  try {
    await assert_publication_claim()
    response = await octokit.rest.pulls.createReview(request)
  } catch (error: unknown) {
    if (event !== 'APPROVE' || !isOwnPullRequestApprovalError(error)) {
      throw error
    }
    // GitHub is the final authority on whether this identity may approve the PR.
    await assert_publication_claim()
    response = await octokit.rest.pulls.createReview({
      ...request,
      event: 'COMMENT'
    })
  }

  return response.data
}

async function findPullRequestReviewByMarker(
  octokit: GitHubAppOctokit,
  {
    owner_login,
    repo_name,
    pr_number,
    marker
  }: Pick<
    CreatePullRequestReviewUnlessMarkerExistsArgs,
    'owner_login' | 'repo_name' | 'pr_number' | 'marker'
  >
): Promise<GitHubPullRequestReview | null> {
  let page = 1

  while (true) {
    const response = await octokit.rest.pulls.listReviews({
      owner: owner_login,
      repo: repo_name,
      pull_number: pr_number,
      per_page: 100,
      page
    })

    if (response.data.length === 0) {
      return null
    }

    for (const review of response.data) {
      if (review.user?.type !== 'Bot') {
        continue
      }
      if (typeof review.body === 'string' && review.body.includes(marker)) {
        return review
      }
    }

    if (response.data.length < 100) {
      return null
    }

    page += 1
  }
}

export async function createPullRequestReviewUnlessMarkerExists(
  octokit: GitHubAppOctokit,
  args: CreatePullRequestReviewUnlessMarkerExistsArgs
): Promise<{ id: number; html_url: string; state: string; reused: boolean }> {
  const existing = await findPullRequestReviewByMarker(octokit, args)
  if (existing !== null) {
    // A run marker is the durable publication identity when a GitHub response is lost.
    return {
      id: existing.id,
      html_url: existing.html_url,
      state: existing.state,
      reused: true
    }
  }

  const created = await createPullRequestReview(octokit, args)
  return {
    ...created,
    reused: false
  }
}
