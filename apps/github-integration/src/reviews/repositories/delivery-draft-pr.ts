import crypto from 'node:crypto'

import { buildDeliveryDraftPrTitle } from './delivery-title.js'
import { buildDeliveryDraftPrBody } from './renderer.js'
import type { Octokit } from 'octokit'
import type { FileChange, FileMode, TextEncoding } from '../file-change.js'
import { validateContractPublishableRepoRelativePath } from '../repo-path.js'
import { sanitizeBranchSegment } from '../shared/branch-name.js'
import type { RepositoryCaseResult, RepositoryDelivery } from './result.js'
import { publishDraftPullRequest } from '../shared/draft-pull-request.js'

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

function stableBranchSegment(value: unknown): string {
  const raw = String(value ?? '').trim() || 'unknown'
  const readable =
    sanitizeBranchSegment(raw).replaceAll('/', '-').slice(0, 48) || 'unknown'
  const digest = crypto
    .createHash('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, 12)
  return `${readable}-${digest}`
}

export function buildRepositoryDeliveryBranchName(
  run_id: string,
  delivery: RepositoryDelivery
): string {
  return `sec-review-bot/repo-scan/${stableBranchSegment(run_id)}/${stableBranchSegment(delivery.delivery_id ?? 'manual')}`
}

function normalizeTargetBranch(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return ''
  }
  return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw
}

function buildRepositorySecurityDeliveryCommitMessage(
  delivery: RepositoryDelivery
): string {
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

function encodeGitFileContent(content_buffer: Buffer): {
  content: string
  encoding: TextEncoding
} {
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

async function buildTreeElements(
  octokit: Octokit,
  delivery: RepositoryDelivery,
  repo: RepositoryContext,
  assertPublicationClaim: () => Promise<void>
): Promise<GitTreeElement[]> {
  const file_entries: FileChange[] = Array.isArray(delivery.file_changes)
    ? delivery.file_changes
    : []
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

    const content_buffer =
      change.content_encoding === 'base64'
        ? Buffer.from(change.content, 'base64')
        : Buffer.from(change.content, 'utf8')
    const blob = encodeGitFileContent(content_buffer)
    await assertPublicationClaim()
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

function validateDeliveryFileChangePaths(delivery: RepositoryDelivery): void {
  const file_entries: FileChange[] = Array.isArray(delivery.file_changes)
    ? delivery.file_changes
    : []
  for (const change of file_entries) {
    validateContractPublishableRepoRelativePath(change.path)
  }
}

export async function createRepositoryDeliveryDraftPr({
  octokit,
  repo,
  run_id,
  input,
  delivery,
  case_results = [],
  assert_publication_claim
}: {
  octokit: Octokit
  repo: RepositoryContext
  run_id: string
  input: RepositoryReviewInput
  delivery: RepositoryDelivery
  case_results?: RepositoryCaseResult[]
  assert_publication_claim: () => Promise<void>
}): Promise<DraftPullRequestSummary> {
  // Validate before idempotent PR reuse so unsafe deliveries never publish or reuse a PR.
  validateDeliveryFileChangePaths(delivery)

  const branch_name = buildRepositoryDeliveryBranchName(run_id, delivery)
  const title = String(buildDeliveryDraftPrTitle(delivery))
  const body = buildDeliveryDraftPrBody({
    repo,
    delivery,
    case_results
  })

  const published = await publishDraftPullRequest({
    octokit,
    owner: repo.owner_login,
    repo: repo.repo_name,
    plan: {
      branch_name,
      head_sha: input.workspace_ref,
      base_branch:
        normalizeTargetBranch(input.scan_target?.target_branch) ||
        repo.default_branch,
      title,
      body,
      commit_message: buildRepositorySecurityDeliveryCommitMessage(delivery),
      build_tree: async () =>
        await buildTreeElements(
          octokit,
          delivery,
          repo,
          assert_publication_claim
        ),
      empty_tree_message:
        'Repository security delivery requires at least one changed file.',
      mismatch_message: `Existing delivery draft PR branch does not match the validated result for ${String(delivery.delivery_id)}.`
    },
    assert_claim: assert_publication_claim
  })
  return {
    branch_name: published.branch_name,
    title: published.title,
    body: published.body,
    html_url: published.html_url,
    number: published.number,
    reused: published.reused
  }
}
