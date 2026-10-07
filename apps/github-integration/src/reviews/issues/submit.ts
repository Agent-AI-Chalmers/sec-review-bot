import type { IssueContext } from '../../infrastructure/github/issue-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { prepareIssueReviewInput } from './prepare-input.js'
import { logInfo } from '../../utils/logger.js'
import type { IssueReviewInput } from '../../infrastructure/runner/input.js'
import { createRunId } from '../shared/input-bundle.js'

interface RunIssueReviewArgs {
  run_id?: string
  octokit: unknown
  issue: IssueContext
  event_type?: 'opened' | 'manual_review' | null
  review_objective?: 'audit' | 'repair' | null
  repair_mode?: 'test-changes-allowed' | 'no-test-changes' | null
  // The caller hands the prepared input to Control Plane for durable submission.
  on_prepared?: (submitted: SubmittedIssueReviewRun, input: IssueReviewInput & Record<string, unknown>) => void | Promise<void>
}

export interface SubmittedIssueReviewRun {
  issue: IssueContext
  run_id: string
  workspace_ref: string
  workflow: string
  event_type: 'opened' | 'manual_review'
}

function assertIssueReviewInput (input: IssueReviewInput): asserts input is IssueReviewInput & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Issue review input is missing before runner invocation.')
  }
}

async function materializeIssueReviewInput ({
  run_id,
  octokit,
  issue,
  event_type = 'manual_review',
  review_objective = 'audit',
  repair_mode
}: RunIssueReviewArgs): Promise<{ run_id: string, input: IssueReviewInput, workspace_ref: string }> {
  const resolvedEventType = event_type ?? 'manual_review'
  const resolvedReviewObjective = review_objective ?? 'audit'
  const resolvedRepairMode = resolvedReviewObjective === 'repair'
    ? repair_mode ?? 'test-changes-allowed'
    : undefined

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

  const prepared = await prepareIssueReviewInput({
    ...(run_id ? { run_id } : {}),
    octokit: octokit as GitHubAppOctokit,
    issue,
    review_objective: resolvedReviewObjective,
    ...(resolvedRepairMode ? { repair_mode: resolvedRepairMode } : {})
  })

  const analysisInput = prepared?.input ?? null

  if (!analysisInput || typeof analysisInput !== 'object' || Array.isArray(analysisInput)) {
    throw new Error(`Issue input materialization returned an invalid value for issue #${issue.issue_number}.`)
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

export async function startIssueReviewRun (args: RunIssueReviewArgs): Promise<SubmittedIssueReviewRun> {
  const run_id = args.run_id ?? createRunId()
  const prepared = await materializeIssueReviewInput({ ...args, run_id })
  const input = prepared.input
  const event_type = args.event_type ?? 'manual_review'
  assertIssueReviewInput(input)
  const preparedRun: SubmittedIssueReviewRun = {
    issue: args.issue,
    run_id: prepared.run_id,
    workspace_ref: prepared.workspace_ref,
    workflow: 'issue-review',
    event_type
  }
  if (args.on_prepared === undefined) throw new Error('Issue review submission callback is required.')
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
