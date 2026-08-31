import { buildDeliveryDraftPrTitle } from './delivery-title.js'
import { buildDeliveryDraftPrBody } from './renderer.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import type { FileChange, FileMode, TextEncoding } from '../file-change.js'
import { validateContractPublishableRepoRelativePath } from '../repo-path.js'
import type { RepositoryCaseResult, RepositoryDelivery } from './result.js'

interface RepositoryContext {
  owner_login: string
  repo_name: string
  default_branch: string
}

interface RepositoryReviewInput {
  workspace_ref: string
  scan_target?: {
    target_branch?: string
  }
}

interface GitTreeElement {
  path: string
  mode: FileMode
  type: 'blob'
  sha: string | null
}

interface DraftPullRequestSummary {
  branch_name: string
  title: string
  body: string | null
  html_url: string
  number: number
  reused: boolean
}

interface GitHubLikeError {
  status?: number
}

function sanitizeBranchSegment (value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

function buildDraftBranchNameFromDelivery (delivery: RepositoryDelivery): string {
  const delivery_id = String(delivery?.delivery_id ?? 'manual').slice(0, 80)
  return sanitizeBranchSegment(`sec-review-bot/repo-scan/${delivery_id}`)
}

function normalizeTargetBranch (value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return ''
  }
  return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw
}

function buildRepositorySecurityDeliveryCommitMessage (delivery: RepositoryDelivery): string {
  const title = String(buildDeliveryDraftPrTitle(delivery) ?? '').trim()
  const normalizedTitle = title
    .replace(/^\[sec\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalizedTitle) {
    return 'sec: apply security mitigation'
  }

  if (/^sec:\s*/i.test(normalizedTitle)) {
    return normalizedTitle
  }

  return `sec: ${normalizedTitle}`
}

function encodeGitFileContent (content_buffer: Buffer): { content: string, encoding: TextEncoding } {
  const isBinary = content_buffer.includes(0)

  if (isBinary) {
    return {
      content: content_buffer.toString('base64'),
      encoding: 'base64'
    }
  }

  return {
    content: content_buffer.toString('utf8'),
    encoding: 'utf-8'
  }
}

async function buildTreeElements (
  octokit: GitHubAppOctokit,
  delivery: RepositoryDelivery,
  repo: RepositoryContext
): Promise<GitTreeElement[]> {
  const file_entries: FileChange[] = Array.isArray(delivery.file_changes) ? delivery.file_changes : []
  const tree_elements: GitTreeElement[] = []
  for (const change of file_entries) {
    const filePath = validateContractPublishableRepoRelativePath(change.path)
    if (change.status === 'deleted') {
      tree_elements.push({
        path: filePath,
        mode: '100644',
        type: 'blob',
        sha: null
      })
      continue
    }

    const content_buffer = change.content_encoding === 'base64'
      ? Buffer.from(change.content, 'base64')
      : Buffer.from(change.content, 'utf8')
    const blob = encodeGitFileContent(content_buffer)
    const blobResponse = await octokit.rest.git.createBlob({
      owner: repo.owner_login,
      repo: repo.repo_name,
      content: blob.content,
      encoding: blob.encoding
    })
    tree_elements.push({
      path: filePath,
      mode: change.mode ?? '100644',
      type: 'blob',
      sha: blobResponse.data.sha
    })
  }

  return tree_elements
}

function validateDeliveryFileChangePaths (delivery: RepositoryDelivery): void {
  const file_entries: FileChange[] = Array.isArray(delivery.file_changes) ? delivery.file_changes : []
  for (const change of file_entries) {
    validateContractPublishableRepoRelativePath(change.path)
  }
}

export async function createRepositoryDeliveryDraftPr ({
  octokit,
  repo,
  input,
  delivery,
  case_results = []
}: {
  octokit: GitHubAppOctokit
  repo: RepositoryContext
  input: RepositoryReviewInput
  delivery: RepositoryDelivery
  case_results?: RepositoryCaseResult[]
}): Promise<DraftPullRequestSummary> {
  // Validate before idempotent PR reuse so unsafe deliveries never publish or reuse a PR.
  validateDeliveryFileChangePaths(delivery)

  const branch_name = buildDraftBranchNameFromDelivery(delivery)
  const title = String(buildDeliveryDraftPrTitle(delivery))
  const body = buildDeliveryDraftPrBody({
    repo,
    delivery,
    case_results
  })

  // Branch name is the delivery publish idempotency key to avoid duplicate PRs on retry.
  const existingPullRequests = await octokit.rest.pulls.list({
    owner: repo.owner_login,
    repo: repo.repo_name,
    state: 'open',
    head: `${repo.owner_login}:${branch_name}`
  })

  if (existingPullRequests.data.length > 0) {
    const existing = existingPullRequests.data[0]
    if (!existing) {
      throw new Error('Failed to resolve existing delivery draft PR.')
    }
    return {
      branch_name,
      title: existing.title,
      body: existing.body,
      html_url: existing.html_url,
      number: existing.number,
      reused: true
    }
  }

  const head_sha = input.workspace_ref
  const commitResponse = await octokit.rest.git.getCommit({
    owner: repo.owner_login,
    repo: repo.repo_name,
    commit_sha: head_sha
  })
  const baseTreeSha = commitResponse.data.tree.sha
  const tree = await buildTreeElements(octokit, delivery, repo)

  if (tree.length === 0) {
    throw new Error('Repository security delivery requires at least one changed file.')
  }

  const treeResponse = await octokit.rest.git.createTree({
    owner: repo.owner_login,
    repo: repo.repo_name,
    base_tree: baseTreeSha,
    tree
  })

  const newCommitResponse = await octokit.rest.git.createCommit({
    owner: repo.owner_login,
    repo: repo.repo_name,
    message: buildRepositorySecurityDeliveryCommitMessage(delivery),
    tree: treeResponse.data.sha,
    parents: [head_sha]
  })

  try {
    await octokit.rest.git.createRef({
      owner: repo.owner_login,
      repo: repo.repo_name,
      ref: `refs/heads/${branch_name}`,
      sha: newCommitResponse.data.sha
    })
  } catch (error) {
    const status = (error as GitHubLikeError | null)?.status
    if (status !== 422) {
      throw error
    }

    await octokit.rest.git.updateRef({
      owner: repo.owner_login,
      repo: repo.repo_name,
      ref: `heads/${branch_name}`,
      sha: newCommitResponse.data.sha,
      force: true
    })
  }

  const pullRequestResponse = await octokit.rest.pulls.create({
    owner: repo.owner_login,
    repo: repo.repo_name,
    title,
    head: branch_name,
    base: normalizeTargetBranch(input.scan_target?.target_branch) || repo.default_branch,
    body,
    draft: true
  })

  return {
    branch_name,
    title,
    body,
    html_url: pullRequestResponse.data.html_url,
    number: pullRequestResponse.data.number,
    reused: false
  }
}
