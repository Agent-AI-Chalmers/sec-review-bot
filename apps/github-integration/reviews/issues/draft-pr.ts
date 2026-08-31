import {
  buildDraftPullRequestBodyFromReviewRecord,
  buildDraftPullRequestTitleFromReviewRecord,
  hasReviewRecordPatchReadyForPromotion,
  normalizePromotionFilePath
} from './renderer.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import type { ReviewRecord } from '../review-record.js'
import type { FileChange, FileMode } from '../file-change.js'

interface IssueContext {
  issue_number: number
  issue_title?: string
  owner_login: string
  repo_name: string
  default_branch: string
}

function sanitizeBranchSegment (value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

function buildDraftBranchName (issue: IssueContext, run_id: string | undefined): string {
  const shortRunId = String(run_id ?? 'manual').replace(/^run-/, '').slice(-8)
  return sanitizeBranchSegment(`sec-review-bot/issue-${issue.issue_number}-${shortRunId}`)
}

function normalizePublishableFileChanges (file_changes: unknown): FileChange[] {
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
        throw new Error(`Issue draft PR file change marked ${normalizedPath} deleted but also included a mode.`)
      }
      seen.add(normalizedPath)
      normalizedChanges.push({
        path: normalizedPath,
        status: 'deleted'
      })
      continue
    }

    const content = typeof rawChange.content === 'string'
      ? rawChange.content
      : null
    const content_encoding = rawChange.content_encoding === 'base64'
      ? 'base64'
      : rawChange.content_encoding === 'utf-8'
        ? 'utf-8'
        : null
    const rawMode = String(rawChange.mode ?? '').trim()
    const mode: FileMode | null = rawMode === '100644' || rawMode === '100755'
      ? rawMode
      : null

    if (rawMode && mode === null) {
      throw new Error(`Issue draft PR file change has unsupported file mode for ${normalizedPath}: ${rawMode}`)
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

async function buildTreeElementsFromFileChanges (
  octokit: GitHubAppOctokit,
  file_changes: FileChange[],
  issue: IssueContext
): Promise<Array<{
  path: string
  mode: FileMode
  type: 'blob'
  sha: string | null
}>> {
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

export async function createDraftPullRequestFromIssueReviewRecord ({
  octokit,
  issue,
  run_id,
  workspace_ref,
  review_record
}: {
  octokit: GitHubAppOctokit
  issue: IssueContext
  run_id: string
  workspace_ref: string
  review_record: ReviewRecord | null | undefined
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

  const file_changes = normalizePublishableFileChanges(review_record?.mitigation?.file_changes)
  const owner = issue.owner_login
  const repo = issue.repo_name
  const base = issue.default_branch
  const head_sha = workspace_ref
  const branch_name = buildDraftBranchName(issue, run_id)
  const title = buildDraftPullRequestTitleFromReviewRecord(issue)
  const body = buildDraftPullRequestBodyFromReviewRecord({ issue, review_record })

  const commitResponse = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: head_sha
  })
  const baseTreeSha = commitResponse.data.tree.sha
  const tree = await buildTreeElementsFromFileChanges(octokit, file_changes, issue)

  if (tree.length === 0) {
    throw new Error('Draft PR creation requires at least one changed file.')
  }

  const treeResponse = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree
  })

  const commitMessage = `Mitigate issue #${issue.issue_number}`
  const newCommitResponse = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: treeResponse.data.sha,
    parents: [head_sha]
  })

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch_name}`,
    sha: newCommitResponse.data.sha
  })

  const pullRequestResponse = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    head: branch_name,
    base,
    body,
    draft: true
  })

  return {
    branch_name,
    title,
    body,
    html_url: pullRequestResponse.data.html_url,
    number: pullRequestResponse.data.number
  }
}
