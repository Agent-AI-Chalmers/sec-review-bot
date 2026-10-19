// Sends the connector-facing acknowledgement for a preparation that exhausted
// its retry budget or failed deterministically. This is intentionally separate
// from result publication: no review result exists on this path.
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

export async function sendPreparationTerminalReply(
  octokit: GitHubAppOctokit,
  args: { run_id: string; input: Record<string, unknown>; failure_code: string }
): Promise<boolean> {
  const target = replyTarget(args.input)
  if (target === null) return false
  const marker = `<!-- sec-review-preparation-failed:${args.run_id} -->`
  await createIssueCommentUnlessMarkerExists(octokit, {
    ...target,
    marker,
    body: `${marker}\n\nSecurity review could not be started after automatic retries. Reference: \`${args.run_id}\`. Reason: \`${args.failure_code}\`.`,
    assert_publication_claim: async () => undefined
  })
  return true
}
