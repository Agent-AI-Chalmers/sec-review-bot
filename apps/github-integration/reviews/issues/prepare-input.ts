import fs from 'fs/promises'
import path from 'path'

import {
  fetchTimelineLinkedPullRequests,
  getIssueDefaultBranchHeadSha,
  type IssueContext
} from '../../infrastructure/github/issue-service.js'
import { getInstallationAccessToken } from '../../infrastructure/github/installation-auth.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import type { IssueReviewInput } from '../../infrastructure/runner/input.js'
import {
  materializeWorkspaceWithCommitHistory
} from '../../infrastructure/runner/git-workspace.js'
import {
  buildGitRemoteUrl,
  createInputBundleRoot,
  createRunId,
  ensureCleanDirectory,
  finalizeInputBundleWorkspace
} from '../shared/input-bundle.js'

async function materializeWorkspace (
  octokit: GitHubAppOctokit,
  issue: IssueContext,
  workspace_path: string,
  ref: string
): Promise<void> {
  const git_auth_token = await getInstallationAccessToken(octokit)
  await materializeWorkspaceWithCommitHistory({
    workspace_path,
    refs: [ref],
    git_remote_url: buildGitRemoteUrl(issue.owner_login, issue.repo_name),
    git_auth_token
  })
}

async function writeJsonArtifact (artifact_path: string, value: unknown): Promise<void> {
  await fs.writeFile(artifact_path, JSON.stringify(value, null, 2), 'utf8')
}

async function materializeHistoryArtifacts ({
  octokit,
  issue,
  history_path,
  workspace_ref
}: {
  octokit: GitHubAppOctokit
  issue: IssueContext
  history_path: string
  workspace_ref: string
}): Promise<{
  issueMetadata: Record<string, unknown>
  linkedPullRequests: Awaited<ReturnType<typeof fetchTimelineLinkedPullRequests>>
}> {
  const issueMetadata = {
    action: issue.action,
    owner: issue.owner_login,
    repo: issue.repo_name,
    repo_full_name: issue.repo_full_name,
    number: issue.issue_number,
    html_url: issue.html_url,
    title: issue.issue_title,
    body: issue.issue_body,
    author_login: issue.issue_author,
    labels: issue.labels,
    default_branch: issue.default_branch,
    workspace_ref
  }
  const linkedPullRequests = await fetchTimelineLinkedPullRequests(octokit, issue)
  await writeJsonArtifact(path.join(history_path, 'issue-metadata.json'), issueMetadata)
  await writeJsonArtifact(path.join(history_path, 'linked-context.json'), {
    generated_at: new Date().toISOString(),
    relation_type: 'cross-referenced',
    source: 'timeline',
    sources_checked: ['timeline'],
    issues: [],
    prs: linkedPullRequests.pull_requests.map((pr) => ({
      ...pr,
      relation_type: 'cross-referenced',
      source: 'timeline'
    }))
  })

  return {
    issueMetadata,
    linkedPullRequests
  }
}

export async function prepareIssueReviewInput ({
  octokit,
  issue,
  review_objective = 'audit',
  repair_mode
}: {
  octokit: GitHubAppOctokit
  issue: IssueContext
  review_objective?: 'audit' | 'repair'
  repair_mode?: 'test-changes-allowed' | 'no-test-changes'
}): Promise<{
  run_id: string
  input: IssueReviewInput
  input_path: string
  input_bundle_root: string
  workspace_ref: string
}> {
  const workspace_ref = await getIssueDefaultBranchHeadSha(octokit, issue)
  const run_id = createRunId()
  const input_bundle_root = createInputBundleRoot(
    issue.repo_full_name,
    `issue-${issue.issue_number}`,
    workspace_ref,
    run_id
  )
  const workspace_path = path.join(input_bundle_root, 'workspace')
  const history_path = path.join(input_bundle_root, 'history')

  await ensureCleanDirectory(input_bundle_root)
  await fs.mkdir(history_path, { recursive: true })

  await materializeWorkspace(octokit, issue, workspace_path, workspace_ref)
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: false
  })
  const historyArtifacts = await materializeHistoryArtifacts({
    octokit,
    issue,
    history_path,
    workspace_ref
  })
  const input: IssueReviewInput = {
    contract_version: 'v4',
    review_intent: {
      objective: review_objective,
      ...(repair_mode ? { repair_mode } : {})
    },
    issue: historyArtifacts.issueMetadata,
    input_bundle_uri: input_bundle_root
  }

  const input_path = path.join(input_bundle_root, 'issue-review-input.json')
  await writeJsonArtifact(input_path, input)

  return {
    run_id,
    input,
    input_path,
    input_bundle_root,
    workspace_ref
  }
}
