// Sends the connector-facing acknowledgement that a run failed. Any axis can produce this: the
// review may never have started, may have started and not finished, or may have finished with a
// result that could not be delivered. The wording follows `failure_stage` so the reply says how
// far the run actually got instead of always claiming it never started.
import { createIssueCommentUnlessMarkerExists } from '../github/comment-service.js'
import type { GitHubAppOctokit } from '../github/octokit.js'
import { isRecord } from '../utils/error-utils.js'
function replyTarget(input: Record<string, unknown>): {
  owner_login: string
  repo_name: string
  issue_number: number
} | null {
  const source = isRecord(input.issue)
    ? input.issue
    : isRecord(input.pr)
      ? input.pr
      : isRecord(input.pr_reference)
        ? input.pr_reference
        : null
  if (
    source === null ||
    typeof source.owner_login !== 'string' ||
    typeof source.repo_name !== 'string' ||
    (typeof source.issue_number !== 'number' &&
      typeof source.pr_number !== 'number')
  )
    return null
  return {
    owner_login: source.owner_login,
    repo_name: source.repo_name,
    issue_number:
      typeof source.issue_number === 'number'
        ? source.issue_number
        : (source.pr_number as number)
  }
}

export type RunFailureStage = 'preparation' | 'execution' | 'publication'

/** How far the run got, in words the requester can act on. */
const STAGE_SENTENCE: Record<RunFailureStage, string> = {
  preparation: 'Security review could not be started after automatic retries.',
  execution: 'Security review started but could not be completed.',
  publication:
    'Security review completed but its result could not be delivered.'
}

export interface RunFailureReplyResult {
  /** The comment that was posted (or already existed) on the requester's issue or pull request. */
  comment_url: string
}

export async function sendRunFailureReply(
  octokit: GitHubAppOctokit,
  args: {
    run_id: string
    input: Record<string, unknown>
    failure_stage: RunFailureStage
    failure_code: string
  }
): Promise<RunFailureReplyResult | null> {
  const target = replyTarget(args.input)
  // No issue or pull request to reply to: there is nowhere for the requester to read the
  // outcome, which the caller records as a failed delivery.
  if (target === null) return null
  // The marker keeps the comment idempotent per run. It names the run only, not the stage: a run
  // that fails once should not collect one comment per axis that happened to observe it.
  const marker = `<!-- sec-review-failed:${args.run_id} -->`
  const posted = await createIssueCommentUnlessMarkerExists(octokit, {
    ...target,
    marker,
    body: `${marker}\n\n${STAGE_SENTENCE[args.failure_stage]} Reference: \`${args.run_id}\`. Reason: \`${args.failure_code}\`.`,
    assert_publication_claim: async () => undefined
  })
  return { comment_url: posted.html_url }
}
