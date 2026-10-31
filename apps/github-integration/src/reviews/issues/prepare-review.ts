import type { IssueContext } from '../../github/issue-service.js'
import type { TrustedDefaultBranch } from '../../github/default-branch-service.js'
import type { Octokit } from 'octokit'
import { prepareIssueReviewInput } from './prepare-input.js'
import { logInfo } from '../../utils/logger.js'
import type {
  IssueReviewInput,
  TestChangesPolicy
} from '../../execution/input.js'

interface PrepareIssueReviewArgs {
  run_id: string
  octokit: Octokit
  issue: IssueContext
  trusted_default_branch: TrustedDefaultBranch
  event_type?: 'opened' | 'manual_review' | null
  review_objective?: 'audit' | 'repair' | null
  test_changes?: TestChangesPolicy | null
  // Whether this run may open a draft PR when the review record contains a ready patch.
  // The end user opts in per comment; automatic triggers leave this false.
  open_pr?: boolean | null
}

interface PrepareIssueReviewDeps {
  // Test seam: defaults to the real preparer. Lets a unit test assert what this
  // layer forwards to the execution input without materializing a git workspace.
  prepare_input: typeof prepareIssueReviewInput
}

export interface PreparedIssueReviewRun {
  issue: IssueContext
  run_id: string
  workspace_ref: string
  workflow: string
  event_type: 'opened' | 'manual_review'
  open_pr: boolean
}

function assertIssueReviewInput(
  input: IssueReviewInput
): asserts input is IssueReviewInput & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Issue review input is missing after preparation.')
  }
}

export async function prepareIssueReview(
  args: PrepareIssueReviewArgs,
  {
    prepare_input = prepareIssueReviewInput
  }: Partial<PrepareIssueReviewDeps> = {}
): Promise<{
  review: PreparedIssueReviewRun
  input: IssueReviewInput & Record<string, unknown>
}> {
  const {
    run_id,
    octokit,
    issue,
    trusted_default_branch,
    event_type,
    review_objective,
    test_changes
  } = args
  const resolvedEventType = event_type ?? 'manual_review'
  const resolvedReviewObjective = review_objective ?? 'audit'
  // `test_changes` constrains the mitigation patch, not the objective. An `audit`
  // review enters mitigation as soon as the analyzer confirms a vulnerability, so an
  // explicit test_changes must reach the Execution Worker for both objectives. When the caller does
  // not supply one, the field is left absent and the Execution Worker applies its own default (`allow`).
  const resolvedTestChanges = test_changes ?? undefined

  logInfo('issue_review_workflow_started', {
    event_type: resolvedEventType,
    issue: issue.issue_number,
    repo: issue.repo_full_name
  })

  logInfo('issue_review_input_materialization_started', {
    event_type: resolvedEventType,
    issue: issue.issue_number,
    repo: issue.repo_full_name
  })

  const prepared = await prepare_input({
    run_id,
    octokit,
    issue,
    trusted_default_branch,
    review_objective: resolvedReviewObjective,
    ...(resolvedTestChanges ? { test_changes: resolvedTestChanges } : {})
  })

  const input = prepared.input
  assertIssueReviewInput(input)

  logInfo('issue_review_input_completed', {
    event_type: resolvedEventType,
    issue: issue.issue_number,
    repo: issue.repo_full_name,
    run_id: prepared.run_id
  })

  return {
    review: {
      issue,
      run_id: prepared.run_id,
      workspace_ref: prepared.workspace_ref,
      workflow: 'issue-review',
      event_type: resolvedEventType,
      open_pr: args.open_pr ?? false
    },
    input
  }
}
