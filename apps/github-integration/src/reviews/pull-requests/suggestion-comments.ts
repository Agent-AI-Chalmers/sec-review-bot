import {
  createPullRequestReviewUnlessMarkerExists,
  type PullRequestReviewEvent,
  type ReviewCommentSide
} from '../../infrastructure/github/comment-service.js'
import type { PersistedPullRequest } from '../../infrastructure/runner/publish-context.js'

interface SuggestionCandidate {
  path: string
  body: string
  line: number
  side: ReviewCommentSide
  start_line: number
}

interface PublishSuggestionReviewArgs {
  pr: PersistedPullRequest
  review_body: string
  event: PullRequestReviewEvent
  candidates: SuggestionCandidate[]
  marker: string
}

export async function publishPullRequestSuggestionReview (
  octokit: Parameters<typeof createPullRequestReviewUnlessMarkerExists>[0],
  {
    pr,
    review_body,
    event,
    candidates,
    marker
  }: PublishSuggestionReviewArgs
): Promise<{
  review_id: number
  html_url: string
  state: string
  count: number
  reused: boolean
  comments: Array<{ path: string, line: number, start_line: number }>
}> {
  const review = await createPullRequestReviewUnlessMarkerExists(octokit, {
    owner_login: pr.owner_login,
    repo_name: pr.repo_name,
    pr_number: pr.pr_number,
    commit_id: pr.head_sha,
    body: review_body,
    event,
    marker,
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
    reused: review.reused,
    count: candidates.length,
    comments: candidates.map((candidate) => ({
      path: candidate.path,
      line: candidate.line,
      start_line: candidate.start_line
    }))
  }
}
