import { CONTRACT_VERSION } from '../../runner/contract-version.js'
import fs from 'fs/promises'
import path from 'path'

import { fetchTimelineLinkedPullRequests, type IssueContext } from '../../github/issue-service.js'
import { type TrustedDefaultBranch } from '../../github/default-branch-service.js'
import { getInstallationAccessToken } from '../../github/installation-auth.js'
import type { GitHubAppOctokit } from '../../github/octokit.js'
import type { IssueReviewInput, TestChangesPolicy } from '../../runner/input.js'
import { materializeWorkspaceWithCommitHistory } from '../../artifacts/git-workspace.js'
import {
  archiveInputBundle,
  buildGitRemoteUrl,
  createInputBundleRoot,
  ensureCleanDirectory,
  finalizeInputBundleWorkspace,
  materializeTrustedSetup
} from '../shared/input-bundle.js'

async function materializeWorkspace(
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

async function writeJsonArtifact(artifact_path: string, value: unknown): Promise<void> {
  await fs.writeFile(artifact_path, JSON.stringify(value, null, 2), 'utf8')
}

async function materializeHistoryArtifacts({
  octokit,
  issue,
  history_path,
  workspace_ref,
  default_branch
}: {
  octokit: GitHubAppOctokit
  issue: IssueContext
  history_path: string
  workspace_ref: string
  default_branch: string
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
    default_branch,
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

export async function prepareIssueReviewInput({
  run_id,
  octokit,
  issue,
  trusted_default_branch,
  review_objective = 'audit',
  test_changes
}: {
  run_id: string
  octokit: GitHubAppOctokit
  issue: IssueContext
  trusted_default_branch: TrustedDefaultBranch
  review_objective?: 'audit' | 'repair'
  test_changes?: TestChangesPolicy
}): Promise<{
  run_id: string
  input: IssueReviewInput
  input_path: string
  input_bundle_root: string
  workspace_ref: string
}> {
  const { default_branch, head_sha: workspace_ref } = trusted_default_branch
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
  const trusted_setup_path = await materializeTrustedSetup({
    input_bundle_root,
    default_sha: workspace_ref,
    owner_login: issue.owner_login,
    repo_name: issue.repo_name
  })
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: false,
    ...(trusted_setup_path ? { trusted_setup_path } : {})
  })
  const historyArtifacts = await materializeHistoryArtifacts({
    octokit,
    issue,
    history_path,
    workspace_ref,
    default_branch
  })
  const input_bundle = await archiveInputBundle({
    input_bundle_root,
    include_incremental_window: false,
    run_id
  })
  const input: IssueReviewInput = {
    contract_version: CONTRACT_VERSION,
    review_intent: {
      objective: review_objective,
      ...(test_changes ? { test_changes } : {})
    },
    issue: historyArtifacts.issueMetadata,
    input_bundle
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
