// Publishing a draft pull request from a validated result.
//
// Both workflows that open a draft PR do the same git work: reuse an open PR for the run's
// branch, resolve the base tree, create a tree, commit it, create the branch, reconcile a branch
// that already exists, then open the PR. That sequence is the protocol; what differs is only the
// content (which files, which message) and the wording of the mismatch report.
//
// The branch name is the publish idempotency key. A retried publish must find its own open PR
// before creating any git object, or a lost response turns into a second PR on the same branch.
import type { Octokit } from 'octokit'

import { DeterministicExecutionPublishError } from '../../execution/publish-error.js'
import type { FileMode } from '../file-change.js'
import { isBranchAlreadyExists } from './branch-already-exists.js'

/** One blob a caller wants in the tree. The content already lives in the object store. */
export interface DraftTreeElement {
  path: string
  mode: FileMode
  type: 'blob'
  sha: string | null
}

export interface DraftPullRequestPlan {
  /** The run-specific branch, which is also the publish idempotency key. */
  branch_name: string
  /** The commit the new branch is based on: the trusted head the result was produced from. */
  head_sha: string
  base_branch: string
  title: string
  body: string
  commit_message: string
  /**
   * Build the tree once this publication is known to be new. Lazy on purpose: building it
   * uploads blobs, and a retry that reuses an existing PR must not do that work again.
   */
  build_tree: () => Promise<DraftTreeElement[]>
  /** Reported when the built tree is empty: a draft PR with no changed file is not a publication. */
  empty_tree_message: string
  /** Reported when an existing branch does not carry this result after all. */
  mismatch_message: string
}

export interface PublishedDraftPullRequest {
  branch_name: string
  title: string
  body: string
  html_url: string
  number: number
  /** True when an open PR for this branch already existed and was reused. */
  reused: boolean
}

/**
 * Publish one draft pull request, or reuse the open PR the same branch already has.
 *
 * The claim is checked before every mutation rather than once at the start: a lease is
 * permission to perform a step, not permission to keep performing it after a heartbeat is lost.
 * A branch that already exists is accepted only when it carries exactly this result — same tree,
 * one parent, same base commit — because a mismatching branch means the name was used for
 * something else and must not be overwritten or presented as this publication.
 */
export async function publishDraftPullRequest({
  octokit,
  owner,
  repo,
  plan,
  assert_claim
}: {
  octokit: Octokit
  owner: string
  repo: string
  plan: DraftPullRequestPlan
  assert_claim: () => Promise<void>
}): Promise<PublishedDraftPullRequest> {
  const existingPullRequests = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${plan.branch_name}`
  })
  const existingPullRequest = existingPullRequests.data[0]
  if (existingPullRequest !== undefined)
    return {
      branch_name: plan.branch_name,
      title: existingPullRequest.title,
      body: existingPullRequest.body ?? plan.body,
      html_url: existingPullRequest.html_url,
      number: existingPullRequest.number,
      reused: true
    }

  const commitResponse = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: plan.head_sha
  })
  const baseTreeSha = commitResponse.data.tree.sha

  const tree = await plan.build_tree()
  if (tree.length === 0) throw new Error(plan.empty_tree_message)

  await assert_claim()
  const treeResponse = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree
  })

  await assert_claim()
  const newCommitResponse = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: plan.commit_message,
    tree: treeResponse.data.sha,
    parents: [plan.head_sha]
  })

  try {
    await assert_claim()
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${plan.branch_name}`,
      sha: newCommitResponse.data.sha
    })
  } catch (error) {
    // An existing run-specific branch is a recovery checkpoint only when it still
    // represents this run's validated result. Do not overwrite it.
    if (!isBranchAlreadyExists(error)) throw error
    await assert_claim()
    const existingRef = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${plan.branch_name}`
    })
    const existingCommit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: existingRef.data.object.sha
    })
    if (
      existingCommit.data.tree.sha !== treeResponse.data.sha ||
      existingCommit.data.parents?.length !== 1 ||
      existingCommit.data.parents[0]?.sha !== plan.head_sha
    ) {
      throw new DeterministicExecutionPublishError(plan.mismatch_message)
    }
  }

  await assert_claim()
  const pullRequestResponse = await octokit.rest.pulls.create({
    owner,
    repo,
    title: plan.title,
    head: plan.branch_name,
    base: plan.base_branch,
    body: plan.body,
    draft: true
  })

  return {
    branch_name: plan.branch_name,
    title: plan.title,
    body: plan.body,
    html_url: pullRequestResponse.data.html_url,
    number: pullRequestResponse.data.number,
    reused: false
  }
}
