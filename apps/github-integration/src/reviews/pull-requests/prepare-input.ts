import { EXECUTION_API_VERSION } from '../../execution/execution-api-version.js'
import fs from 'fs/promises'
import path from 'path'

import {
  fetchTimelineLinkedIssues,
  resolveTrustedRepositoryIdentity,
  type PullRequestContext
} from '../../github/pull-request-service.js'
import { type TrustedDefaultBranch } from '../../github/default-branch-service.js'
import type { Octokit } from 'octokit'
import type {
  InputBundleArtifactRef,
  PullRequestReviewInput,
  PullRequestReviewSubject
} from '../../execution/input.js'
import type { TestChangesPolicy } from '../../execution/input.js'
import { MAX_PR_COMMIT_SHAS } from '../../execution/input.js'
import { getInstallationAccessToken } from '../../github/installation-auth.js'
import {
  exportWorkspaceWindow,
  materializeWorkspaceWithCommitHistory
} from '../../artifacts/git-workspace.js'
import type { ReviewWindow } from './review-window.js'
import {
  archiveInputBundleAndPublish,
  buildGitRemoteUrl,
  createInputBundleRoot,
  ensureCleanDirectory,
  finalizeInputBundleWorkspace,
  readSetupDeclaration
} from '../shared/input-bundle.js'

export interface PreparedPullRequestReview {
  run_id: string
  input: PullRequestReviewInput
  input_path: string
  input_bundle_root: string
  files: Awaited<ReturnType<typeof exportWorkspaceWindow>>['files']
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

/**
 * Build the pull request subject a review run carries.
 *
 * Only fields with a consumer are included: the preparation path, the recovery
 * path, and the agent prompts. Endpoint URLs, commit counts, and sender identity
 * had no reader, so keeping them only made the run's subject ambiguous.
 */
function buildPrMetadata(
  pr: PullRequestContext,
  window: ReviewWindow,
  commit_shas: string[]
): PullRequestReviewSubject {
  return {
    // These names are the wire contract shared with the local materializer and
    // the v1 fixture; they are not the names of the fields they are read from.
    owner: pr.owner_login,
    repo: pr.repo_name,
    repo_full_name: pr.repo_full_name,
    number: pr.pr_number,
    title: pr.pr_title,
    body: pr.pr_body,
    base_ref: pr.base_ref,
    base_sha: pr.base_sha,
    head_ref: pr.head_ref,
    head_sha: pr.head_sha,
    commit_shas,
    // The window this run covers. It labels the materialized `changed-files.json`
    // and `incremental.patch`; on `synchronize` it is narrower than
    // base_sha..head_sha, which stays as pull request identity.
    review_window: {
      kind: window.kind,
      base_sha: window.base_sha,
      head_sha: window.head_sha,
      reason: window.reason
    }
  }
}

async function listCommitChainRefsForPullRequest({
  octokit,
  pr
}: {
  octokit: Octokit
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

  const uniqueRefs = refs.filter(
    (item, index, array) => array.indexOf(item) === index
  )
  if (uniqueRefs.length === 0) {
    return [pr.head_sha]
  }
  return uniqueRefs
}

async function materializeWorkspaceHistory({
  octokit,
  pr,
  workspace_path,
  window,
  commit_refs
}: {
  octokit: Octokit
  pr: PullRequestContext
  workspace_path: string
  window: ReviewWindow
  commit_refs: string[]
}): Promise<void> {
  const git_auth_token = await getInstallationAccessToken(octokit)

  // The window's base is part of the comparison, so it has to be present even
  // when it is not the pull request's own base. On `synchronize` it is the
  // previous head, which is no longer on the current commit chain and would
  // otherwise be missing from the workspace entirely.
  await materializeWorkspaceWithCommitHistory({
    workspace_path,
    refs: [pr.base_sha, window.base_sha, ...commit_refs],
    window_base_sha: window.base_sha,
    git_remote_url: buildGitRemoteUrl(pr.owner_login, pr.repo_name),
    git_auth_token
  })
}

async function materializeIncrementalWindowArtifacts({
  workspace_path,
  window,
  incremental_window_path
}: {
  workspace_path: string
  window: ReviewWindow
  incremental_window_path: string
}): Promise<Awaited<ReturnType<typeof exportWorkspaceWindow>>['files']> {
  // One workspace comparison produces the patch and the file list together, so they cannot
  // describe different change sets. The API cannot serve this role: its compare response caps at
  // 300 files and the pull request files endpoint at 3000, while the diff has no cap, so a large
  // run would list fewer files than its patch contains.
  const { patch: incremental_patch, files: changed_files } =
    await exportWorkspaceWindow({
      workspace_path,
      base_sha: window.base_sha,
      head_sha: window.head_sha
    })

  await Promise.all([
    fs.writeFile(
      path.join(incremental_window_path, 'incremental.patch'),
      incremental_patch,
      'utf8'
    ),
    fs.writeFile(
      path.join(incremental_window_path, 'changed-files.json'),
      JSON.stringify(
        {
          // `changed-files.json` keeps the `path` field the agent-facing schema describes; the
          // suggestion set uses `filename`. Both come from one export.
          files: changed_files.map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions
          }))
        },
        null,
        2
      ),
      'utf8'
    )
  ])
  return changed_files
}

async function materializeHistoryArtifacts({
  octokit,
  pr,
  window,
  commit_shas,
  history_path
}: {
  octokit: Octokit
  pr: PullRequestContext
  window: ReviewWindow
  commit_shas: string[]
  history_path: string
}): Promise<{
  pr_metadata: PullRequestReviewSubject
  linkedIssues: Awaited<ReturnType<typeof fetchTimelineLinkedIssues>>
}> {
  const pr_metadata = buildPrMetadata(pr, window, commit_shas)
  const linkedIssues = await fetchTimelineLinkedIssues(octokit, pr)

  await fs.writeFile(
    path.join(history_path, 'pr-metadata.json'),
    // The agent gets the window and the commit list only. Identity fields stay
    // in the execution input: an agent reading a full identity record spends
    // context on values it cannot act on, and every extra range-shaped field is
    // another candidate for what the review boundary is.
    JSON.stringify(
      {
        review_window: pr_metadata.review_window,
        commit_shas: pr_metadata.commit_shas
      },
      null,
      2
    ),
    'utf8'
  )

  await fs.writeFile(
    path.join(history_path, 'linked-context.json'),
    JSON.stringify(
      {
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
  window,
  trusted_default_branch,
  test_changes = null
}: {
  run_id: string
  octokit: Octokit
  pr: PullRequestContext
  window: ReviewWindow
  trusted_default_branch: TrustedDefaultBranch
  test_changes?: TestChangesPolicy | null
}): Promise<PreparedPullRequestReview> {
  const input_bundle_root = createInputBundleRoot(
    pr.repo_full_name,
    `pr-${pr.pr_number}`,
    pr.head_sha,
    run_id
  )
  const workspace_path = path.join(input_bundle_root, 'workspace')
  const incremental_window_path = path.join(
    input_bundle_root,
    'incremental-window'
  )
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
  // Every SHA is inlined into the workflow input, and the commit list is paginated, so nothing
  // else bounds it. Refuse here, with a message that names the limit, instead of failing later
  // in transport. The value matches `maxItems` on `pr.commit_shas` in the v1 schema.
  if (commit_shas.length > MAX_PR_COMMIT_SHAS) {
    throw new Error(
      `pull request has too many commits: ${commit_shas.length} exceeds the limit of ` +
        `${MAX_PR_COMMIT_SHAS}`
    )
  }

  await materializeWorkspaceHistory({
    octokit,
    pr,
    workspace_path,
    window,
    commit_refs: commit_shas
  })
  const default_sha = trusted_default_branch.head_sha
  // Read from the exact default-branch commit through the Contents API; the
  // installation auth rides on `octokit` rather than a git token. Resolve the
  // repository identity the same way the default-branch SHA was resolved
  // (`resolveTrustedRepositoryIdentity`, which prefers the base repo): reading
  // the declaration from a *different* repository than the one whose HEAD SHA we
  // hold would 404 and silently degrade to "no declaration".
  const repository_identity = resolveTrustedRepositoryIdentity(pr)
  const setup_declaration = await readSetupDeclaration({
    octokit,
    default_sha,
    owner_login: repository_identity.owner_login,
    repo_name: repository_identity.repo_name
  })
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: true
  })
  const files = await materializeIncrementalWindowArtifacts({
    workspace_path,
    window,
    incremental_window_path
  })

  const historyArtifacts = await materializeHistoryArtifacts({
    octokit,
    pr,
    window,
    commit_shas,
    history_path
  })
  const pullRequestMetadata = historyArtifacts.pr_metadata
  // The bundle is published only after the input that references it fits, so a failure here
  // cannot leave an unreferenced immutable bundle behind.
  const { input } = await archiveInputBundleAndPublish<PullRequestReviewInput>({
    input_bundle_root,
    include_incremental_window: true,
    run_id,
    workflow: 'pull request review',
    build_input: (
      reference: InputBundleArtifactRef
    ): PullRequestReviewInput => ({
      api_version: EXECUTION_API_VERSION,
      review_intent: {
        objective: 'audit',
        ...(test_changes ? { test_changes } : {})
      },
      pr: pullRequestMetadata,
      input_bundle: reference,
      ...(setup_declaration ? { setup_declaration } : {})
    })
  })

  const input_path = path.join(
    input_bundle_root,
    'pull-request-review-input.json'
  )
  await fs.writeFile(input_path, JSON.stringify(input, null, 2), 'utf8')

  // The suggestion anchoring set comes from the same workspace diff as the patch, so a file the
  // patch changes is always anchorable. The API's per-file `patch` cannot serve this: it is
  // omitted for part of a large pull request.
  return {
    run_id,
    input,
    input_path,
    input_bundle_root,
    files
  }
}
