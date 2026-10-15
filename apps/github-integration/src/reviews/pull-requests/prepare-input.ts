import { CONTRACT_VERSION } from '../../runner/contract-version.js'
import fs from 'fs/promises'
import path from 'path'

import {
  fetchTimelineLinkedIssues,
  summarizePullRequestFiles,
  type PullRequestContext,
  type PullRequestFile,
  type PullRequestFileSummary
} from '../../github/pull-request-service.js'
import { type TrustedDefaultBranch } from '../../github/default-branch-service.js'
import type { GitHubAppOctokit } from '../../github/octokit.js'
import type { PullRequestReviewInput } from '../../runner/input.js'
import type { TestChangesPolicy } from '../../runner/input.js'
import { getInstallationAccessToken } from '../../github/installation-auth.js'
import { materializeWorkspaceWithCommitHistory } from '../../artifacts/git-workspace.js'
import {
  archiveInputBundle,
  buildGitRemoteUrl,
  createInputBundleRoot,
  ensureCleanDirectory,
  finalizeInputBundleWorkspace,
  readSetupDeclaration
} from '../shared/input-bundle.js'

interface NormalizedPullRequestFile {
  path: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch: string | null
}

interface IncrementalChangedFileEntry {
  path: string
  status: string
  previous_path: string | null
  additions: number
  deletions: number
  changes: number
}

export interface PreparedPullRequestReview {
  run_id: string
  input: PullRequestReviewInput
  input_path: string
  input_bundle_root: string
  files: PullRequestFile[]
}

interface PullRequestCommitsConnection {
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
  }
  nodes?: Array<{ commit?: { oid?: string } }>
}

interface PullRequestCommitsGraphQLResponse {
  repository?: {
    pullRequest?: {
      commits?: PullRequestCommitsConnection
    }
  }
}

function buildPrMetadata(pr: PullRequestContext): Record<string, unknown> {
  return {
    action: pr.action,
    owner: pr.owner_login,
    repo: pr.repo_name,
    repo_full_name: pr.repo_full_name,
    number: pr.pr_number,
    html_url: pr.html_url,
    title: pr.pr_title,
    body: pr.pr_body,
    author_login: pr.pr_author,
    is_draft: pr.is_draft,
    base_ref: pr.base_ref,
    base_sha: pr.base_sha,
    head_ref: pr.head_ref,
    head_sha: pr.head_sha,
    previous_head_sha: pr.previous_head_sha ?? null
  }
}

function normalizeFiles(files: PullRequestFile[]): NormalizedPullRequestFile[] {
  return summarizePullRequestFiles(files).map((file: PullRequestFileSummary) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch
  }))
}

function buildIncrementalPatchText(files: NormalizedPullRequestFile[]): string {
  const chunks: string[] = []

  for (const file of files) {
    if (typeof file.patch !== 'string' || file.patch.trim() === '') {
      continue
    }

    chunks.push(
      `diff --git a/${file.path} b/${file.path}`,
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      file.patch
    )
  }

  return chunks.join('\n')
}

async function listCommitChainRefsForPullRequest({
  octokit,
  pr
}: {
  octokit: GitHubAppOctokit
  pr: PullRequestContext
}): Promise<string[]> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          commits(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              commit {
                oid
              }
            }
          }
        }
      }
    }
  `

  const refs: string[] = []
  let cursor: string | null = null

  while (true) {
    const response: PullRequestCommitsGraphQLResponse =
      await octokit.graphql<PullRequestCommitsGraphQLResponse>(query, {
        owner: pr.owner_login,
        repo: pr.repo_name,
        number: pr.pr_number,
        cursor
      })

    const commits: PullRequestCommitsConnection | undefined =
      response?.repository?.pullRequest?.commits
    const nodes = Array.isArray(commits?.nodes) ? commits.nodes : []
    for (const node of nodes) {
      const sha = String(node?.commit?.oid ?? '').trim()
      if (sha) {
        refs.push(sha)
      }
    }

    const pageInfo: PullRequestCommitsConnection['pageInfo'] = commits?.pageInfo
    if (!pageInfo?.hasNextPage) {
      break
    }

    cursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null
    if (!cursor) {
      break
    }
  }

  const uniqueRefs = refs.filter((item, index, array) => array.indexOf(item) === index)
  if (uniqueRefs.length === 0) {
    return [pr.head_sha]
  }
  return uniqueRefs
}

async function materializeWorkspaceHistory({
  octokit,
  pr,
  workspace_path,
  commit_refs
}: {
  octokit: GitHubAppOctokit
  pr: PullRequestContext
  workspace_path: string
  commit_refs: string[]
}): Promise<void> {
  const git_auth_token = await getInstallationAccessToken(octokit)

  await materializeWorkspaceWithCommitHistory({
    workspace_path,
    refs: [pr.base_sha, ...commit_refs],
    git_remote_url: buildGitRemoteUrl(pr.owner_login, pr.repo_name),
    git_auth_token
  })
}

async function materializeIncrementalWindowArtifacts(
  files: NormalizedPullRequestFile[],
  incremental_window_path: string
): Promise<void> {
  const changed_files: IncrementalChangedFileEntry[] = files.map((file) => ({
    path: file.path,
    status: file.status,
    previous_path: null,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes
  }))

  await Promise.all([
    fs.writeFile(
      path.join(incremental_window_path, 'incremental.patch'),
      buildIncrementalPatchText(files),
      'utf8'
    ),
    fs.writeFile(
      path.join(incremental_window_path, 'changed-files.json'),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          files: changed_files
        },
        null,
        2
      ),
      'utf8'
    )
  ])
}

async function materializeHistoryArtifacts({
  octokit,
  pr,
  history_path
}: {
  octokit: GitHubAppOctokit
  pr: PullRequestContext
  history_path: string
}): Promise<{
  pr_metadata: Record<string, unknown>
  linkedIssues: Awaited<ReturnType<typeof fetchTimelineLinkedIssues>>
}> {
  const pr_metadata = buildPrMetadata(pr)
  const linkedIssues = await fetchTimelineLinkedIssues(octokit, pr)

  await fs.writeFile(
    path.join(history_path, 'pr-metadata.json'),
    JSON.stringify(pr_metadata, null, 2),
    'utf8'
  )

  await fs.writeFile(
    path.join(history_path, 'linked-context.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        relation_type: 'cross-referenced',
        source: 'timeline',
        sources_checked: ['timeline'],
        issues: linkedIssues.issues.map((issue) => ({
          ...issue,
          relation_type: 'cross-referenced',
          source: 'timeline'
        })),
        prs: []
      },
      null,
      2
    ),
    'utf8'
  )

  return {
    pr_metadata,
    linkedIssues
  }
}

export async function preparePullRequestReviewInput({
  run_id,
  octokit,
  pr,
  files,
  trusted_default_branch,
  test_changes = null
}: {
  run_id: string
  octokit: GitHubAppOctokit
  pr: PullRequestContext
  files: PullRequestFile[]
  trusted_default_branch: TrustedDefaultBranch
  test_changes?: TestChangesPolicy | null
}): Promise<PreparedPullRequestReview> {
  const normalizedFiles = normalizeFiles(files)
  const input_bundle_root = createInputBundleRoot(
    pr.repo_full_name,
    `pr-${pr.pr_number}`,
    pr.head_sha,
    run_id
  )
  const workspace_path = path.join(input_bundle_root, 'workspace')
  const incremental_window_path = path.join(input_bundle_root, 'incremental-window')
  const history_path = path.join(input_bundle_root, 'history')

  await ensureCleanDirectory(input_bundle_root)
  await Promise.all([
    fs.mkdir(incremental_window_path, { recursive: true }),
    fs.mkdir(history_path, { recursive: true })
  ])
  const commit_shas = await listCommitChainRefsForPullRequest({
    octokit,
    pr
  })

  await materializeWorkspaceHistory({
    octokit,
    pr,
    workspace_path,
    commit_refs: commit_shas
  })
  const default_sha = trusted_default_branch.head_sha
  const git_auth_token = await getInstallationAccessToken(octokit)
  const setup_declaration = await readSetupDeclaration({
    default_sha,
    owner_login: pr.owner_login,
    repo_name: pr.repo_name,
    git_auth_token
  })
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: true
  })
  await materializeIncrementalWindowArtifacts(normalizedFiles, incremental_window_path)
  const historyArtifacts = await materializeHistoryArtifacts({
    octokit,
    pr,
    history_path
  })
  const pullRequestMetadata = {
    ...historyArtifacts.pr_metadata,
    commit_shas
  }
  const input_bundle = await archiveInputBundle({
    input_bundle_root,
    include_incremental_window: true,
    run_id
  })
  const input: PullRequestReviewInput = {
    contract_version: CONTRACT_VERSION,
    review_intent: {
      objective: 'audit',
      ...(test_changes ? { test_changes } : {})
    },
    pr: pullRequestMetadata,
    input_bundle,
    ...(setup_declaration ? { setup_declaration } : {})
  }

  const input_path = path.join(input_bundle_root, 'pull-request-review-input.json')
  await fs.writeFile(input_path, JSON.stringify(input, null, 2), 'utf8')

  return {
    run_id,
    input,
    input_path,
    input_bundle_root,
    files
  }
}
