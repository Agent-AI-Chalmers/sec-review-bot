import {
  createPullRequestReview,
  type PullRequestReviewEvent,
  type ReviewCommentSide
} from '../../infrastructure/github/comment-service.js'
import type { PullRequestContext } from '../../infrastructure/github/pull-request-service.js'

interface SuggestionCandidate {
  path: string
  body: string
  line: number
  side: ReviewCommentSide
  start_line: number
}

interface PublishSuggestionReviewArgs {
  pr: PullRequestContext
  review_body: string
  event: PullRequestReviewEvent
  candidates: SuggestionCandidate[]
}

export async function publishPullRequestSuggestionReview (
  octokit: Parameters<typeof createPullRequestReview>[0],
  {
    pr,
    review_body,
    event,
    candidates
  }: PublishSuggestionReviewArgs
): Promise<{
  review_id: number
  html_url: string
  state: string
  count: number
  comments: Array<{ path: string, line: number, start_line: number }>
}> {
  const review = await createPullRequestReview(octokit, {
    owner_login: pr.owner_login,
    repo_name: pr.repo_name,
    pr_number: pr.pr_number,
    commit_id: pr.head_sha,
    body: review_body,
    event,
    comments: candidates.map((candidate) => ({
      path: candidate.path,
      body: candidate.body,
      line: candidate.line,
      side: candidate.side,
      ...(candidate.start_line === candidate.line
        ? {}
        : {
            start_line: candidate.start_line,
            start_side: candidate.side
          })
    }))
  })

  return {
    review_id: review.id,
    html_url: review.html_url,
    state: review.state,
    count: candidates.length,
    comments: candidates.map((candidate) => ({
      path: candidate.path,
      line: candidate.line,
      start_line: candidate.start_line
    }))
  }
}
