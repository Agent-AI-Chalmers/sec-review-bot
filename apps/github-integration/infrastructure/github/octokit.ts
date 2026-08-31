// Shared shape for the GitHub App installation-scoped Octokit used across the app.
// This intentionally avoids per-service "OctokitLike" types: runtime passes one
// installation client around, and services normalize the endpoint responses they read.
type TextEncoding = 'utf-8' | 'base64'
type GitBlobMode = '100644' | '100755'

interface GitHubPullRequestFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  blob_url?: string | null
  raw_url?: string | null
  patch?: string | null
  previous_filename?: string
}

interface GitHubCommitSummary {
  sha?: string
  commit?: {
    message?: string
    author?: {
      name?: string
      date?: string
    }
  }
  author?: {
    login?: string
  }
}

interface GitHubRepositoryIssue {
  number: number
  title: string
  pull_request?: unknown
}

interface GitHubIssueComment {
  id: number
  body?: string | null
  html_url: string
  user?: {
    type?: string
  } | null
}

interface GitHubOpenPullRequest {
  number: number
  title: string
  html_url: string
  body: string | null
  head?: {
    ref?: string
  }
}

export interface GitHubAppOctokit {
  auth: (options?: unknown) => Promise<unknown>
  graphql: <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown }>
  rest: {
    git: {
      createBlob: (args: {
        owner: string
        repo: string
        content: string
        encoding: TextEncoding
      }) => Promise<{ data: { sha: string } }>
      createCommit: (args: {
        owner: string
        repo: string
        message: string
        tree: string
        parents: string[]
      }) => Promise<{ data: { sha: string } }>
      createRef: (args: {
        owner: string
        repo: string
        ref: string
        sha: string
      }) => Promise<unknown>
      createTree: (args: {
        owner: string
        repo: string
        base_tree: string
        tree: Array<{
          path: string
          mode: GitBlobMode
          type: 'blob'
          sha: string | null
        }>
      }) => Promise<{ data: { sha: string } }>
      getCommit: (args: {
        owner: string
        repo: string
        commit_sha: string
      }) => Promise<{ data: { tree: { sha: string } } }>
      updateRef: (args: {
        owner: string
        repo: string
        ref: string
        sha: string
        force: boolean
      }) => Promise<unknown>
    }
    issues: {
      create: (args: {
        owner: string
        repo: string
        title: string
        body: string
      }) => Promise<{ data: GitHubRepositoryIssue }>
      createComment: (args: {
        owner: string
        repo: string
        issue_number: number
        body: string
      }) => Promise<{ data: { id: number, html_url: string } }>
      listComments: (args: {
        owner: string
        repo: string
        issue_number: number
        per_page: number
        page: number
      }) => Promise<{ data: GitHubIssueComment[] }>
      get: (args: {
        owner: string
        repo: string
        issue_number: number
      }) => Promise<{ data: Record<string, unknown> }>
      listEventsForTimeline: (args: {
        owner: string
        repo: string
        issue_number: number
        per_page: number
        page: number
      }) => Promise<{ data: Array<Record<string, unknown>> }>
      listForRepo: (args: {
        owner: string
        repo: string
        state: 'open'
        per_page: number
        page: number
      }) => Promise<{ data: GitHubRepositoryIssue[] }>
    }
    pulls: {
      create: (args: {
        owner: string
        repo: string
        title: string
        head: string
        base: string
        body: string | null
        draft: boolean
      }) => Promise<{ data: { html_url: string, number: number } }>
      createReview: (args: {
        owner: string
        repo: string
        pull_number: number
        commit_id: string
        body: string
        event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'
        comments: Array<{
          path: string
          body: string
          line: number
          side: string
          start_line?: number
          start_side?: string
        }>
      }) => Promise<{ data: { id: number, html_url: string, state: string } }>
      createReviewComment: (args: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>
      get: (args: {
        owner: string
        repo: string
        pull_number: number
      }) => Promise<{ data: Record<string, unknown> }>
      list: (args: {
        owner: string
        repo: string
        state: 'open'
        per_page?: number
        page?: number
        head?: string
      }) => Promise<{ data: GitHubOpenPullRequest[] }>
      listFiles: (args: {
        owner: string
        repo: string
        pull_number: number
        per_page: number
        page: number
      }) => Promise<{ data: GitHubPullRequestFile[] }>
    }
    repos: {
      compareCommitsWithBasehead: (args: {
        owner: string
        repo: string
        basehead: string
      }) => Promise<{
        data: {
          status?: string
          files?: GitHubPullRequestFile[]
          commits?: GitHubCommitSummary[]
        }
      }>
      downloadTarballArchive: (args: {
        owner: string
        repo: string
        ref: string
      }) => Promise<{ data: ArrayBuffer | Buffer | string }>
      get: (args: {
        owner: string
        repo: string
      }) => Promise<{
        data: {
          full_name: string
          default_branch: string
          html_url: string
          private: boolean
        }
      }>
      getCollaboratorPermissionLevel: (args: {
        owner: string
        repo: string
        username: string
      }) => Promise<{ data: { permission?: string } }>
      getBranch: (args: {
        owner: string
        repo: string
        branch: string
      }) => Promise<{ data: { commit: { sha: string } } }>
      getCommit: (args: {
        owner: string
        repo: string
        ref: string
      }) => Promise<{ data: { sha: string } }>
      listCommits: (args: {
        owner: string
        repo: string
        sha?: string
        until?: string
        per_page?: number
      }) => Promise<{ data: GitHubCommitSummary[] }>
      getContent: (args: {
        owner: string
        repo: string
        path: string
        ref?: string
      }) => Promise<{ data: { content?: string } | Array<unknown> }>
    }
  }
}
