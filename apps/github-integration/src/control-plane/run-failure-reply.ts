// Sends the connector-facing acknowledgement that a run failed. Any axis can produce this: the
// review may never have started, may have started and not finished, or may have finished with a
// result that could not be delivered. The wording follows `failure_stage` so the reply says how
// far the run actually got instead of always claiming it never started.
import { createIssueCommentUnlessMarkerExists } from '../github/comment-service.js'
import type { Octokit } from 'octokit'
import { asErrorWithResponse, isRecord } from '../utils/error-utils.js'
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

/** Refuse to act on a repository this app is not installed on.
 *
 * The Octokit passed to the reply path is installation-scoped, so a repository outside that
 * installation is invisible to it. Any repository-naming failure notice is therefore verified
 * here before it can cause a write: for a repository scan the target comes from a persisted
 * `verified_repository`, and creating a summary issue or comment in a repository the run never
 * touched would let persisted state drive public writes outside the installation.
 *
 * A 404 (or a 403, which reveals the same "cannot prove access") is reported as a deterministic
 * failure so the caller records the notice as undelivered instead of retrying forever. Any other
 * fault is rethrown and stays retryable: a transient GitHub outage must not discard a terminal
 * outcome. */
async function assertRepositoryIsInstalled(
  octokit: Octokit,
  target: { owner_login: string; repo_name: string }
): Promise<void> {
  try {
    await octokit.rest.repos.get({
      owner: target.owner_login,
      repo: target.repo_name
    })
  } catch (error) {
    const status = asErrorWithResponse(error).status
    if (status === 404 || status === 403) {
      // Carry the status on the error we throw rather than only its message. The caller decides
      // retryability from `classifyPreparationFailure`, which retries when a status is absent:
      // a bare Error here would be re-claimed every lease period forever, while a 404/403 is
      // deterministic and concludes the notice as undelivered once.
      throw Object.assign(
        new Error(
          `Run failure notice target ${target.owner_login}/${target.repo_name} is not installed on this app.`
        ),
        { status }
      )
    }
    throw error
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

/** The summary issue that reports for a repository scan.
 *
 * The lookup-or-create is the publish path's own helper, so a failure and a success can never
 * disagree about which issue reports for a repository. Its publication-claim callback is a no-op
 * here because a failure notice has no publication claim to assert - creating this issue is
 * reporting, not publishing a scan result.
 *
 * This performs a public write (it may create the issue), so `sendRunFailureReply` verifies the
 * repository against the installation before calling it. */
async function ensureRepositorySummaryIssue(
  octokit: Octokit,
  scope: { owner_login: string; repo_name: string }
): Promise<number> {
  const repo = {
    owner_login: scope.owner_login,
    repo_name: scope.repo_name,
    repo_full_name: `${scope.owner_login}/${scope.repo_name}`,
    default_branch: ''
  }
  return await ensureSummaryIssueNumber(octokit, repo, async () => undefined)
}

export interface RunFailureReplyResult {
  /** The comment that was posted (or already existed) on the requester's issue or pull request. */
  comment_url: string
}

export async function sendRunFailureReply(
  octokit: Octokit,
  args: {
    run_id: string
    input: Record<string, unknown>
    failure_stage: RunFailureStage
    failure_code: string
  }
): Promise<RunFailureReplyResult | null> {
  // Resolve where the outcome belongs. A conversation (issue/PR) is named directly by persisted
  // input; a repository scan has no conversation, so it reports to that repository's summary
  // issue, which may not exist yet.
  const conversation = replyTarget(args.input)
  const scanScope = conversation === null ? repositoryScope(args.input) : null

  // The installation-scoped client is the authority on which repositories this app may write to.
  // Verify exactly once, before any write: a persisted target outside the installation must not
  // create a summary issue or a comment. This runs before the summary-issue lookup-or-create.
  let target: {
    owner_login: string
    repo_name: string
    issue_number: number
  } | null
  if (conversation !== null) {
    await assertRepositoryIsInstalled(octokit, conversation)
    target = conversation
  } else {
    // Neither a conversation nor a repository to report to: there is nowhere for the requester
    // to read the outcome, which the caller records as a failed delivery.
    if (scanScope === null) return null
    await assertRepositoryIsInstalled(octokit, scanScope)
    target = {
      ...scanScope,
      issue_number: await ensureRepositorySummaryIssue(octokit, scanScope)
    }
  }

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
