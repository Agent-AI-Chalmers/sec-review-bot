import fs from 'fs/promises'
import path from 'path'

import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'

export interface RepositoryContext {
  owner_login: string
  repo_name: string
}

export interface ChangedFileRecord {
  path: string
  status: string
  previous_path: string | null
  additions: number
  deletions: number
  changes: number
}

function asRecord (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function writeJsonArtifact (artifact_path: string, value: unknown): Promise<void> {
  await fs.writeFile(artifact_path, JSON.stringify(value, null, 2), 'utf8')
}

export async function materializeIncrementalArtifacts ({
  octokit,
  repo,
  incremental_window_path,
  history_path,
  run_id,
  event_type,
  base_sha,
  head_sha
}: {
  octokit: GitHubAppOctokit
  repo: RepositoryContext
  incremental_window_path: string
  history_path: string
  run_id: string
  event_type: 'manual' | 'scheduled'
  base_sha: string
  head_sha: string
}): Promise<{
  changed_files: ChangedFileRecord[]
  commit_shas: string[]
}> {
  await fs.mkdir(incremental_window_path, { recursive: true })
  await fs.mkdir(history_path, { recursive: true })

  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: repo.owner_login,
    repo: repo.repo_name,
    basehead: `${base_sha}...${head_sha}`
  })
  const files = Array.isArray(compare.data?.files) ? compare.data.files : []
  const commitsRaw = Array.isArray(compare.data?.commits)
    ? compare.data.commits as unknown[]
    : []

  const compareDiff = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner_login,
    repo: repo.repo_name,
    basehead: `${base_sha}...${head_sha}`,
    headers: {
      accept: 'application/vnd.github.v3.diff'
    }
  })
  const patchText = typeof compareDiff.data === 'string' ? compareDiff.data : ''
  await fs.writeFile(path.join(incremental_window_path, 'incremental.patch'), patchText, 'utf8')

  const changed_files: ChangedFileRecord[] = []
  for (const item of files) {
    const currentPath = String(item?.filename ?? '').trim()
    if (!currentPath) {
      continue
    }
    const statusRaw = String(item?.status ?? '').trim().toLowerCase()
    const status = statusRaw === 'renamed'
      ? 'renamed'
      : statusRaw === 'added'
          ? 'added'
          : statusRaw === 'removed'
              ? 'deleted'
              : 'modified'
    const additions = Number.isFinite(Number(item?.additions)) ? Number(item?.additions) : 0
    const deletions = Number.isFinite(Number(item?.deletions)) ? Number(item?.deletions) : 0
    const changes = Number.isFinite(Number(item?.changes)) ? Number(item?.changes) : additions + deletions
    changed_files.push({
      path: currentPath,
      status,
      previous_path: String(item?.previous_filename ?? '').trim() || null,
      additions,
      deletions,
      changes
    })
  }

  changed_files.sort((a, b) => a.path.localeCompare(b.path))

  await writeJsonArtifact(path.join(incremental_window_path, 'changed-files.json'), {
    base_sha,
    head_sha,
    files: changed_files
  })

  const commits = commitsRaw
    .map((item) => {
      const commit = asRecord(asRecord(item).commit)
      const commitAuthor = asRecord(commit.author)
      const author = asRecord(asRecord(item).author)
      const message = String(commit.message ?? '').trim()
      const title = message.split('\n')[0] ?? ''
      return {
        sha: String(asRecord(item).sha ?? '').trim(),
        title: String(title).trim(),
        author: String(author.login ?? commitAuthor.name ?? '').trim(),
        committed_at: String(commitAuthor.date ?? '').trim()
      }
    })
    .filter((item) => item.sha !== '')
  const commit_shas = commits.map((item) => item.sha).filter((sha) => sha !== '')

  await writeJsonArtifact(path.join(history_path, 'commits.json'), {
    base_sha,
    head_sha,
    commits
  })

  await writeJsonArtifact(path.join(history_path, 'scan-window.json'), {
    run_id,
    event_type,
    scan_mode: 'incremental',
    base_sha,
    head_sha,
    changed_file_count: changed_files.length,
    generated_at: new Date().toISOString()
  })

  return {
    changed_files,
    commit_shas
  }
}

export async function isAncestorCommit ({
  octokit,
  repo,
  base_sha,
  head_sha
}: {
  octokit: GitHubAppOctokit
  repo: RepositoryContext
  base_sha: string
  head_sha: string
}): Promise<boolean> {
  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: repo.owner_login,
    repo: repo.repo_name,
    basehead: `${base_sha}...${head_sha}`
  })
  return String(compare.data?.status ?? '').trim().toLowerCase() === 'ahead'
}
