import type { GitHubAppOctokit } from './octokit.js'

interface RepoParts {
  owner_login: string
  repo_name: string
}

interface RepositoryContext extends RepoParts {
  repo_full_name: string
  default_branch: string
  html_url: string
  private: boolean
}

interface OpenRepositorySecurityPullRequest {
  number: number
  title: string
  html_url: string
  head_ref: string
}

interface RepositoryIssue {
  number: number
  title: string
  pull_request?: unknown
}

function splitRepoFullName (repo_full_name: string): RepoParts {
  const text = String(repo_full_name || '').trim()
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(text)

  if (!match) {
    throw new Error(`Invalid repository full name: ${repo_full_name}`)
  }
  const owner_login = match[1] as string
  const repo_name = match[2] as string
  if (!/[A-Za-z0-9]/.test(repo_name)) {
    throw new Error(`Invalid repository full name: ${repo_full_name}`)
  }

  return {
    owner_login,
    repo_name
  }
}

export async function getRepositoryContext (octokit: GitHubAppOctokit, repo_full_name: string): Promise<RepositoryContext> {
  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const response = await octokit.rest.repos.get({
    owner: owner_login,
    repo: repo_name
  })

  return {
    owner_login,
    repo_name,
    repo_full_name: response.data.full_name,
    default_branch: response.data.default_branch,
    html_url: response.data.html_url,
    private: response.data.private
  }
}

export async function getRepositoryRefSha (
  octokit: GitHubAppOctokit,
  { owner_login, repo_name, ref }: RepoParts & { ref: string }
): Promise<string> {
  const normalizedRef = String(ref || '').trim()
  if (!normalizedRef) {
    throw new Error('Repository ref is required.')
  }

  try {
    const response = await octokit.rest.repos.getBranch({
      owner: owner_login,
      repo: repo_name,
      branch: normalizedRef
    })
    return response.data.commit.sha
  } catch {
    const commit = await octokit.rest.repos.getCommit({
      owner: owner_login,
      repo: repo_name,
      ref: normalizedRef
    })
    return commit.data.sha
  }
}

export async function listOpenRepositorySecurityPullRequests (
  octokit: GitHubAppOctokit,
  { owner_login, repo_name }: RepoParts
): Promise<OpenRepositorySecurityPullRequest[]> {
  const items: OpenRepositorySecurityPullRequest[] = []
  let page = 1

  while (true) {
    const response = await octokit.rest.pulls.list({
      owner: owner_login,
      repo: repo_name,
      state: 'open',
      per_page: 100,
      page
    })

    if (response.data.length === 0) {
      break
    }

    for (const item of response.data) {
      const head_ref = item.head?.ref ?? ''
      if (!head_ref.startsWith('sec-review-bot/repo-scan/')) {
        continue
      }

      items.push({
        number: item.number,
        title: item.title,
        html_url: item.html_url,
        head_ref
      })
    }

    if (response.data.length < 100) {
      break
    }

    page += 1
  }

  return items
}

export async function findRepositorySecuritySummaryIssue (
  octokit: GitHubAppOctokit,
  { owner_login, repo_name, title }: RepoParts & { title: string }
): Promise<RepositoryIssue | null> {
  let page = 1

  while (true) {
    const response = await octokit.rest.issues.listForRepo({
      owner: owner_login,
      repo: repo_name,
      state: 'open',
      per_page: 100,
      page
    })

    if (response.data.length === 0) {
      return null
    }

    for (const item of response.data) {
      if (item.pull_request) {
        continue
      }

      if (item.title === title) {
        return item
      }
    }

    if (response.data.length < 100) {
      return null
    }

    page += 1
  }
}

export {
  splitRepoFullName
}
