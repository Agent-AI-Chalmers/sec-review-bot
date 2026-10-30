import {
  buildDraftPullRequestBodyFromReviewRecord,
  buildDraftPullRequestTitleFromReviewRecord,
  hasReviewRecordPatchReadyForPromotion,
  normalizePromotionFilePath
} from './renderer.js'
import type { Octokit } from 'octokit'
import type { ReviewRecord } from '../review-record.js'
import type { FileChange, FileMode } from '../file-change.js'
import { sanitizeBranchSegment } from '../shared/branch-name.js'
import { resolveTrustedDefaultBranch } from '../../github/default-branch-service.js'
import { publishDraftPullRequest } from '../shared/draft-pull-request.js'

interface IssueContext {
  issue_number: number
  issue_title?: string
  owner_login: string
  repo_name: string
}

export function buildDraftBranchName(
  issue: IssueContext,
  run_id: string | undefined
): string {
  // The whole run id, not a slice of it. The branch is the publication's idempotency key: an
  // existing branch is verified against this run's tree and reused, so a name two runs share
  // makes one run adopt the other's branch - or, when the trees differ, conclude that its own
  // validated result "does not match" and fail. The last 8 hex characters of a UUID collide
  // after about 65k runs, which is reachable in a busy deployment; the full id cannot.
  // A UUID is already git-ref-safe, but it still goes through the shared sanitizer so every
  // branch segment this package builds obeys the same ref rules.
  const runSegment = sanitizeBranchSegment(String(run_id ?? 'manual'))
  return `sec-review-bot/issue-${issue.issue_number}-${runSegment}`
}

function normalizePublishableFileChanges(file_changes: unknown): FileChange[] {
  if (!Array.isArray(file_changes)) {
    return []
  }

  const normalizedChanges: FileChange[] = []
  const seen = new Set<string>()

  for (const item of file_changes) {
    if (item === null || typeof item !== 'object') {
      continue
    }
    const rawChange = item as Record<string, unknown>
    const normalizedPath = normalizePromotionFilePath(rawChange.path)

    if (!normalizedPath || seen.has(normalizedPath)) {
      continue
    }

    if (rawChange.status === 'deleted') {
      if (rawChange.mode) {
        throw new Error(
          `Issue draft PR file change marked ${normalizedPath} deleted but also included a mode.`
        )
      }
      seen.add(normalizedPath)
      normalizedChanges.push({
        path: normalizedPath,
        status: 'deleted'
      })
      continue
    }

    const content =
      typeof rawChange.content === 'string' ? rawChange.content : null
    const content_encoding =
      rawChange.content_encoding === 'base64'
        ? 'base64'
        : rawChange.content_encoding === 'utf-8'
          ? 'utf-8'
          : null
    const rawMode = String(rawChange.mode ?? '').trim()
    const mode: FileMode | null =
      rawMode === '100644' || rawMode === '100755' ? rawMode : null

    if (rawMode && mode === null) {
      throw new Error(
        `Issue draft PR file change has unsupported file mode for ${normalizedPath}: ${rawMode}`
      )
    }

    if (content === null || content_encoding === null) {
      continue
    }

    seen.add(normalizedPath)
    normalizedChanges.push({
      path: normalizedPath,
      status: 'upsert',
      content,
      content_encoding,
      ...(mode ? { mode } : {})
    })
  }

  return normalizedChanges
}

async function buildTreeElementsFromFileChanges(
  octokit: Octokit,
  file_changes: FileChange[],
  issue: IssueContext,
  assertPublicationClaim: () => Promise<void>
): Promise<
  Array<{
    path: string
    mode: FileMode
    type: 'blob'
    sha: string | null
  }>
> {
  const tree_elements: Array<{
    path: string
    mode: FileMode
    type: 'blob'
    sha: string | null
  }> = []

  for (const change of file_changes) {
    if (change.status === 'deleted') {
      tree_elements.push({
        path: change.path,
        mode: '100644',
        type: 'blob',
        sha: null
      })
      continue
    }

    await assertPublicationClaim()
    const blobResponse = await octokit.rest.git.createBlob({
      owner: issue.owner_login,
      repo: issue.repo_name,
      content: change.content,
      encoding: change.content_encoding
    })
    tree_elements.push({
      path: change.path,
      mode: change.mode ?? '100644',
      type: 'blob',
      sha: blobResponse.data.sha
    })
  }

  return tree_elements
}

export async function createDraftPullRequestFromIssueReviewRecord({
  octokit,
  issue,
  run_id,
  workspace_ref,
  review_record,
  assert_publication_claim
}: {
  octokit: Octokit
  issue: IssueContext
  run_id: string
  workspace_ref: string
  review_record: ReviewRecord | null | undefined
  assert_publication_claim: () => Promise<void>
}): Promise<{
  branch_name: string
  title: string
  body: string
  html_url: string
  number: number
} | null> {
  if (!hasReviewRecordPatchReadyForPromotion(review_record)) {
    return null
  }

  const file_changes = normalizePublishableFileChanges(
    review_record?.mitigation?.file_changes
  )
  const owner = issue.owner_login
  const repo = issue.repo_name
  // Resolve the PR base from the API rather than the webhook payload's
  // `repository.default_branch`: the base of a bot-opened draft PR is a
  // trust-relevant ref, and the rest of the flow already refuses payload-derived
  // refs. `workspace_ref` (the head the commit is based on) is the same
  // API-resolved default-branch SHA.
  const base = (
    await resolveTrustedDefaultBranch(octokit, {
      owner_login: owner,
      repo_name: repo
    })
  ).default_branch
  const head_sha = workspace_ref
  const branch_name = buildDraftBranchName(issue, run_id)
  const title = buildDraftPullRequestTitleFromReviewRecord(issue)
  const body = buildDraftPullRequestBodyFromReviewRecord({
    issue,
    review_record
  })

  const published = await publishDraftPullRequest({
    octokit,
    owner,
    repo,
    plan: {
      branch_name,
      head_sha,
      base_branch: base,
      title,
      body,
      commit_message: `Mitigate issue #${issue.issue_number}`,
      build_tree: async () =>
        await buildTreeElementsFromFileChanges(
          octokit,
          file_changes,
          issue,
          assert_publication_claim
        ),
      empty_tree_message:
        'Draft PR creation requires at least one changed file.',
      mismatch_message: `Existing draft PR branch does not match the validated result for run ${run_id}.`
    },
    assert_claim: assert_publication_claim
  })
  return {
    branch_name: published.branch_name,
    title: published.title,
    body: published.body,
    html_url: published.html_url,
    number: published.number
  }
}
