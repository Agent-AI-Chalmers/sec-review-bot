// Sends the connector-facing acknowledgement that a run failed. Any axis can produce this: the
// review may never have started, may have started and not finished, or may have finished with a
// result that could not be delivered. The wording follows `failure_stage` so the reply says how
// far the run actually got instead of always claiming it never started.
import { createIssueCommentUnlessMarkerExists } from '../github/comment-service.js'
import type { GitHubAppOctokit } from '../github/octokit.js'
import { isRecord } from '../utils/error-utils.js'
import { ensureSummaryIssueNumber } from '../reviews/repositories/publish.js'
import { repositoryFullName } from '../github/repository-service.js'
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

/** The repository a repository-review run scanned, when the notice belongs to one.
 *
 * A repository scan has no conversation of its own: it is dispatched from GitHub Actions or a
 * schedule, so its preparation input carries only `verified_repository` and the dispatch
 * payload. Without this the notice had nowhere to go and was recorded as an undelivered failure,
 * leaving the person who started the scan with no signal at all.
 *
 * The summary issue is where a successful scan already reports, so a failure belongs there too:
 * the reader who looks for scan results finds the failure in the same place. `ensureSummaryIssueNumber`
 * performs the same lookup-or-create the publish path uses.
 *
 * The value is validated rather than split: a failure notice is read back from persisted state,
 * and `owner/repo/extra` split naively would silently report into `owner/repo` — the wrong
 * repository — while surrounding whitespace would become part of the name. Anything that is not
 * exactly two non-empty segments is treated as having no target, which the caller records as an
 * undelivered notice instead of posting the outcome somewhere misleading. */
function repositoryScope(input: Record<string, unknown>): {
  owner_login: string
  repo_name: string
} | null {
  if (input.kind !== 'github_repository_review') return null
  // The same normalization the installation lookup uses, so a value one path rejects is also
  // rejected here instead of being posted to a repository the scan never named.
  const fullName = repositoryFullName(input.verified_repository)
  if (fullName === null) return null
  const [owner_login, repo_name] = fullName.split('/')
  if (!owner_login || !repo_name) return null
  return { owner_login, repo_name }
}

export type RunFailureStage = 'preparation' | 'execution' | 'publication'

/** How far the run got, in words the requester can act on. */
const STAGE_SENTENCE: Record<RunFailureStage, string> = {
  preparation: 'Security review could not be started after automatic retries.',
  execution: 'Security review started but could not be completed.',
  publication:
    'Security review completed but its result could not be delivered.'
}

/** Resolve a repository scan's failure target: the summary issue for that repository.
 *
 * The lookup-or-create is the publish path's own helper, so a failure and a success can never
 * disagree about which issue reports for a repository. Its publication-claim callback is a no-op
 * here because a failure notice has no publication claim to assert - creating this issue is
 * reporting, not publishing a scan result. */
async function repositoryReviewTarget(
  octokit: GitHubAppOctokit,
  input: Record<string, unknown>
): Promise<{
  owner_login: string
  repo_name: string
  issue_number: number
} | null> {
  const scope = repositoryScope(input)
  if (scope === null) return null
  const repo = {
    owner_login: scope.owner_login,
    repo_name: scope.repo_name,
    repo_full_name: `${scope.owner_login}/${scope.repo_name}`,
    default_branch: ''
  }
  const issue_number = await ensureSummaryIssueNumber(
    octokit,
    repo,
    async () => undefined
  )
  return { ...scope, issue_number }
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
  const target =
    replyTarget(args.input) ??
    (await repositoryReviewTarget(octokit, args.input))
  // Neither a conversation nor a repository to report to: there is nowhere for the requester to
  // read the outcome, which the caller records as a failed delivery.
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
