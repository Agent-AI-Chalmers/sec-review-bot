import type { GitHubAppOctokit } from './octokit.js'

/**
 * Resolve the default branch of the repository under review via the GitHub API.
 *
 * This is the reference point for anything that must come from a trusted source:
 *
 *  - The branch name and its head SHA are both resolved server-side.
 *  - Webhook payload fields are not trusted: a payload may name an arbitrary
 *    branch, and "the SHA of branch X" does not prove "X is the default branch".
 *  - On failure this throws. Callers must fail explicitly rather than fall back
 *    to a payload-derived ref, which would silently weaken the trust boundary.
 */
export interface TrustedDefaultBranch {
  default_branch: string
  head_sha: string
}

export interface TrustedDefaultBranchArgs {
  owner_login: string
  repo_name: string
}

/**
 * Resolve `{default_branch, head_sha}` for the repository itself, by API.
 * Throws on any failure (403/404/timeout/rate-limit/...); never reads payload.
 */
export async function resolveTrustedDefaultBranch(
  octokit: GitHubAppOctokit,
  { owner_login, repo_name }: TrustedDefaultBranchArgs
): Promise<TrustedDefaultBranch> {
  const repository = await octokit.rest.repos.get({
    owner: owner_login,
    repo: repo_name
  })

  const default_branch = String(repository.data.default_branch || '').trim()
  if (!default_branch) {
    throw new Error(
      `GitHub returned an empty default branch for ${owner_login}/${repo_name}.`
    )
  }

  const branch = await octokit.rest.repos.getBranch({
    owner: owner_login,
    repo: repo_name,
    branch: default_branch
  })

  const head_sha = String(branch.data.commit?.sha || '').trim()
  if (!head_sha) {
    throw new Error(
      `GitHub returned an empty head SHA for ${owner_login}/${repo_name}@${default_branch}.`
    )
  }

  return { default_branch, head_sha }
}
