import { CONTRACT_VERSION } from '../../runner/contract-version.js'
import fs from 'fs/promises'
import path from 'path'

import {
  fetchTimelineLinkedPullRequests,
  type IssueContext
} from '../../github/issue-service.js'
import { type TrustedDefaultBranch } from '../../github/default-branch-service.js'
import { getInstallationAccessToken } from '../../github/installation-auth.js'
import type { Octokit } from 'octokit'
import type {
  InputBundleArtifactRef,
  IssueReviewInput,
  TestChangesPolicy
} from '../../runner/input.js'
import { materializeWorkspaceWithCommitHistory } from '../../artifacts/git-workspace.js'
import {
  archiveInputBundleAndPublish,
  buildGitRemoteUrl,
  createInputBundleRoot,
  ensureCleanDirectory,
  finalizeInputBundleWorkspace,
  readSetupDeclaration
} from '../shared/input-bundle.js'

async function materializeWorkspace(
  octokit: Octokit,
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

async function writeJsonArtifact(
  artifact_path: string,
  value: unknown
): Promise<void> {
  await fs.writeFile(artifact_path, JSON.stringify(value, null, 2), 'utf8')
}

async function materializeHistoryArtifacts({
  octokit,
  issue,
  history_path
}: {
  octokit: Octokit
  issue: IssueContext
  history_path: string
}): Promise<{
  issueMetadata: IssueReviewInput['issue']
  linkedPullRequests: Awaited<
    ReturnType<typeof fetchTimelineLinkedPullRequests>
  >
}> {
  // The runner validates this against the v6 issue schema, which forbids additional
  // properties. Identity fields plus what the prompts render; `default_branch` and
  // `workspace_ref` are already consumed when the bundle is built, so recording them here
  // would add fields no consumer reads.
  const issueMetadata = {
    owner: issue.owner_login,
    repo: issue.repo_name,
    repo_full_name: issue.repo_full_name,
    number: issue.issue_number,
    title: issue.issue_title,
    body: issue.issue_body
  }
  const linkedPullRequests = await fetchTimelineLinkedPullRequests(
    octokit,
    issue
  )
  await writeJsonArtifact(
    path.join(history_path, 'issue-metadata.json'),
    issueMetadata
  )
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
  octokit: Octokit
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
  const { head_sha: workspace_ref } = trusted_default_branch
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
  // The setup declaration is read from the exact default-branch commit through
  // the Contents API, which carries the installation auth on `octokit` itself.
  const setup_declaration = await readSetupDeclaration({
    octokit,
    default_sha: workspace_ref,
    owner_login: issue.owner_login,
    repo_name: issue.repo_name
  })
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: false
  })
  const historyArtifacts = await materializeHistoryArtifacts({
    octokit,
    issue,
    history_path
  })
  // The bundle is published only after the input that references it fits, so a failure here
  // cannot leave an unreferenced immutable bundle behind.
  const { input } = await archiveInputBundleAndPublish<IssueReviewInput>({
    input_bundle_root,
    include_incremental_window: false,
    run_id,
    workflow: 'issue review',
    build_input: (reference: InputBundleArtifactRef): IssueReviewInput => ({
      contract_version: CONTRACT_VERSION,
      review_intent: {
        objective: review_objective,
        ...(test_changes ? { test_changes } : {})
      },
      issue: historyArtifacts.issueMetadata,
      input_bundle: reference,
      ...(setup_declaration ? { setup_declaration } : {})
    })
  })

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
