import type { Octokit } from 'octokit'

import { wasAuthoredByCurrentAppBot } from './github-app-metadata-service.js'
import { asErrorWithResponse } from '../utils/error-utils.js'

/** A single pull-request review, as the SDK returns it. */
type GitHubPullRequestReview = Awaited<
  ReturnType<Octokit['rest']['pulls']['listReviews']>
>['data'][number]

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
    login?: string
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

// Bound the final payload, including the retry marker and truncation notice.
const MAX_COMMENT_BODY_LENGTH = 65_536
const HTML_ESCAPES: Partial<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function boundedCommentBody(body: string, marker = ''): string {
  if (body.length <= MAX_COMMENT_BODY_LENGTH) {
    return body
  }

  const suffix = `\n</pre>\n\nComment shortened for GitHub. Consult the run's persisted review record for complete review results.\n\n${marker}`
  const prefix = '<pre>\n'
  const budget = MAX_COMMENT_BODY_LENGTH - prefix.length - suffix.length
  if (budget < 0) {
    throw new Error('Publication marker exceeds the GitHub comment body budget.')
  }

  // An escaped preview cannot leave an open Markdown fence, HTML tag, or
  // partially applicable suggestion. Iterate code points to preserve Unicode.
  const preview: string[] = []
  let length = 0
  for (const character of body) {
    const escaped = HTML_ESCAPES[character] ?? character
    if (length + escaped.length > budget) {
      break
    }
    preview.push(escaped)
    length += escaped.length
  }
  return `${prefix}${preview.join('')}${suffix}`
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
      ? responseErrors.map((item: unknown) => {
          if (typeof item === 'object' && item !== null && 'message' in item) {
            return String(item.message)
          }
          return String(item)
        })
      : [typeof responseErrors === 'string' ? responseErrors : ''])
  ].filter((item): item is string => typeof item === 'string' && item.trim() !== '')

  return errorTexts.some((item) => {
    const text = item.toLowerCase()
    return text.includes('approve') && text.includes('own pull request')
  })
}

async function createIssueComment(
  octokit: Octokit,
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

export async function findIssueCommentByMarker(
  octokit: Octokit,
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
      if (!wasAuthoredByCurrentAppBot(comment.user)) {
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
  octokit: Octokit,
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
    { owner_login, repo_name, issue_number, body: boundedCommentBody(body, marker) },
    assert_publication_claim
  )
  return {
    ...created,
    reused: false
  }
}

async function createPullRequestReview(
  octokit: Octokit,
  {
    owner_login,
    repo_name,
    pr_number,
    commit_id,
    body,
    event = 'COMMENT',
    comments,
    assert_publication_claim
  }: CreatePullRequestReviewArgs & {
    assert_publication_claim: () => Promise<void>
  }
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

  let response: Awaited<ReturnType<Octokit['rest']['pulls']['createReview']>>
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

export async function findPullRequestReviewByMarker(
  octokit: Octokit,
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
      if (!wasAuthoredByCurrentAppBot(review.user)) {
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
  octokit: Octokit,
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

  const created = await createPullRequestReview(octokit, {
    ...args,
    body: boundedCommentBody(args.body, args.marker),
    comments: args.comments.map((comment) => ({
      ...comment,
      body: boundedCommentBody(comment.body)
    }))
  })
  return {
    ...created,
    reused: false
  }
}
