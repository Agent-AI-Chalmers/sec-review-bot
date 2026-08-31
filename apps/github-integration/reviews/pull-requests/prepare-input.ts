import fs from 'fs/promises'
import path from 'path'

import {
  fetchTimelineLinkedIssues,
  summarizePullRequestFiles,
  type PullRequestContext,
  type PullRequestFile,
  type PullRequestFileSummary
} from '../../infrastructure/github/pull-request-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import type { PullRequestReviewInput } from '../../infrastructure/runner/input.js'
import type { RepairMode } from '../../infrastructure/runner/input.js'
import { getInstallationAccessToken } from '../../infrastructure/github/installation-auth.js'
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

function buildPrMetadata (pr: PullRequestContext): Record<string, unknown> {
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

function normalizeFiles (files: PullRequestFile[]): NormalizedPullRequestFile[] {
  return summarizePullRequestFiles(files).map((file: PullRequestFileSummary) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch
  }))
}

function buildIncrementalPatchText (files: NormalizedPullRequestFile[]): string {
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

async function listCommitChainRefsForPullRequest ({
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
    const response: PullRequestCommitsGraphQLResponse = await octokit.graphql<PullRequestCommitsGraphQLResponse>(query, {
      owner: pr.owner_login,
      repo: pr.repo_name,
      number: pr.pr_number,
      cursor
    })

    const commits: PullRequestCommitsConnection | undefined = response?.repository?.pullRequest?.commits
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

async function materializeWorkspaceHistory ({
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

async function materializeIncrementalWindowArtifacts (
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
    fs.writeFile(path.join(incremental_window_path, 'incremental.patch'), buildIncrementalPatchText(files), 'utf8'),
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

async function materializeHistoryArtifacts ({
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
    JSON.stringify({
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
    }, null, 2),
    'utf8'
  )

  return {
    pr_metadata,
    linkedIssues
  }
}

export async function preparePullRequestReviewInput ({
  octokit,
  pr,
  files,
  repair_mode = null
}: {
  octokit: GitHubAppOctokit
  pr: PullRequestContext
  files: PullRequestFile[]
  repair_mode?: RepairMode | null
}): Promise<PreparedPullRequestReview> {
  const normalizedFiles = normalizeFiles(files)
  const run_id = createRunId()
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
  const input: PullRequestReviewInput = {
    contract_version: 'v4',
    review_intent: {
      objective: 'audit',
      ...(repair_mode ? { repair_mode } : {})
    },
    pr: pullRequestMetadata,
    input_bundle_uri: input_bundle_root
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
