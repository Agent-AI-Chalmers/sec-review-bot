import type { IssueContext } from '../../github/issue-service.js'
import type { GitHubAppOctokit } from '../../github/octokit.js'
import { prepareIssueReviewInput } from './prepare-input.js'
import { logInfo } from '../../utils/logger.js'
import type { IssueReviewInput, TestChangesPolicy } from '../../runner/input.js'

interface RunIssueReviewArgs {
  run_id: string
  octokit: unknown
  issue: IssueContext
  event_type?: 'opened' | 'manual_review' | null
  review_objective?: 'audit' | 'repair' | null
  test_changes?: TestChangesPolicy | null
  // Whether this run may open a draft PR when the review record contains a ready patch.
  // The end user opts in per comment; automatic triggers leave this false.
  open_pr?: boolean | null
  // The caller hands the prepared input to Control Plane for durable submission.
  on_prepared?: (
    submitted: SubmittedIssueReviewRun,
    input: IssueReviewInput & Record<string, unknown>
  ) => void | Promise<void>
  // Test seam: defaults to the real preparer. Lets a unit test assert what this
  // layer forwards to the runner input without materializing a git workspace.
  prepare_input?: typeof prepareIssueReviewInput
}

export interface SubmittedIssueReviewRun {
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
    throw new Error('Issue review input is missing before runner invocation.')
  }
}

async function materializeIssueReviewInput({
  run_id,
  octokit,
  issue,
  event_type = 'manual_review',
  review_objective = 'audit',
  test_changes,
  prepare_input = prepareIssueReviewInput
}: RunIssueReviewArgs): Promise<{
  run_id: string
  input: IssueReviewInput
  workspace_ref: string
}> {
  const resolvedEventType = event_type ?? 'manual_review'
  const resolvedReviewObjective = review_objective ?? 'audit'
  // `test_changes` constrains the mitigation patch, not the objective. An `audit`
  // review enters mitigation as soon as the analyzer confirms a vulnerability, so an
  // explicit test_changes must reach the runner for both objectives. When the caller does
  // not supply one, the field is left absent and the runner applies its own default (`allow`).
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
    octokit: octokit as GitHubAppOctokit,
    issue,
    review_objective: resolvedReviewObjective,
    ...(resolvedTestChanges ? { test_changes: resolvedTestChanges } : {})
  })

  const analysisInput = prepared?.input ?? null

  if (!analysisInput || typeof analysisInput !== 'object' || Array.isArray(analysisInput)) {
    throw new Error(
      `Issue input materialization returned an invalid value for issue #${issue.issue_number}.`
    )
  }

  logInfo('issue_review_input_completed', {
    event_type: resolvedEventType,
    issue: issue.issue_number,
    repo: issue.repo_full_name,
    run_id: prepared.run_id
  })

  return {
    run_id: prepared.run_id,
    input: analysisInput,
    workspace_ref: prepared.workspace_ref
  }
}

export async function startIssueReviewRun(
  args: RunIssueReviewArgs
): Promise<SubmittedIssueReviewRun> {
  const prepared = await materializeIssueReviewInput(args)
  const input = prepared.input
  const event_type = args.event_type ?? 'manual_review'
  assertIssueReviewInput(input)
  const preparedRun: SubmittedIssueReviewRun = {
    issue: args.issue,
    run_id: prepared.run_id,
    workspace_ref: prepared.workspace_ref,
    workflow: 'issue-review',
    event_type,
    open_pr: args.open_pr ?? false
  }
  if (args.on_prepared === undefined)
    throw new Error('Issue review submission callback is required.')
  await args.on_prepared(preparedRun, input)
  logInfo('issue_review_runner_run_submitted', {
    event_type,
    issue: args.issue.issue_number,
    repo: args.issue.repo_full_name,
    run_id: prepared.run_id,
    workflow: preparedRun.workflow
  })
  return preparedRun
}
