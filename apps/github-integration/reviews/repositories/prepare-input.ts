import fs from 'fs/promises'
import path from 'path'

import {
  getRepositoryContext,
  getRepositoryRefSha
} from '../../infrastructure/github/repository-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import type {
  RepairMode,
  RepositoryReviewInput
} from '../../infrastructure/runner/input.js'
import { getInstallationAccessToken } from '../../infrastructure/github/installation-auth.js'
import {
  materializeWorkspaceWithCommitHistory
} from '../../infrastructure/runner/git-workspace.js'
import {
  isAncestorCommit,
  materializeIncrementalArtifacts,
  type ChangedFileRecord
} from './incremental-artifacts.js'
import {
  buildGitRemoteUrl,
  createInputBundleRoot,
  createRunId,
  finalizeInputBundleWorkspace
} from '../shared/input-bundle.js'

const MAX_INCREMENTAL_FILES = 5000

interface RepositoryContext {
  owner_login: string
  repo_name: string
  repo_full_name: string
  default_branch: string
}

type RepositoryScanMode = 'full' | 'incremental'

function normalizeScanMode (value: unknown): RepositoryScanMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'full' || raw === 'incremental') {
    return raw
  }
  throw new Error(`Unsupported repository scan_mode: ${String(value)}`)
}

async function materializeWorkspace (
  octokit: GitHubAppOctokit,
  repo: RepositoryContext,
  workspace_path: string,
  refs: string[]
): Promise<void> {
  const git_auth_token = await getInstallationAccessToken(octokit)

  await materializeWorkspaceWithCommitHistory({
    workspace_path,
    refs,
    git_remote_url: buildGitRemoteUrl(repo.owner_login, repo.repo_name),
    git_auth_token
  })
}

async function writeJsonArtifact (artifact_path: string, value: unknown): Promise<void> {
  await fs.writeFile(artifact_path, JSON.stringify(value, null, 2), 'utf8')
}

export async function prepareRepositoryReviewInput ({
  octokit,
  repo_full_name,
  target_branch = null,
  scan_mode,
  base_sha = null,
  head_sha = null,
  event_type = 'manual',
  paths_ignore = [],
  repair_mode = null
}: {
  octokit: GitHubAppOctokit
  repo_full_name: string
  target_branch?: string | null
  scan_mode: RepositoryScanMode
  base_sha?: string | null
  head_sha?: string | null
  event_type?: 'manual' | 'scheduled'
  paths_ignore?: string[]
  repair_mode?: RepairMode | null
}): Promise<{
  run_id: string
  repo: RepositoryContext
  workspace_ref: string
  input: RepositoryReviewInput
  input_path: string
  input_bundle_root: string
}> {
  const repo = await getRepositoryContext(octokit, repo_full_name)
  const targetBranchForResolution = target_branch || repo.default_branch
  const headResolutionTarget = head_sha || targetBranchForResolution
  const resolvedHeadSha = await getRepositoryRefSha(octokit, {
    owner_login: repo.owner_login,
    repo_name: repo.repo_name,
    ref: headResolutionTarget
  })
  const run_id = createRunId()
  const input_bundle_root = createInputBundleRoot(
    repo.repo_full_name,
    'repository-review',
    resolvedHeadSha,
    run_id
  )
  const workspace_path = path.join(input_bundle_root, 'workspace')
  const incremental_window_path = path.join(input_bundle_root, 'incremental-window')
  const history_path = path.join(input_bundle_root, 'history')

  await fs.mkdir(input_bundle_root, { recursive: true })
  await Promise.all([
    fs.mkdir(incremental_window_path, { recursive: true }),
    fs.mkdir(history_path, { recursive: true })
  ])

  const resolvedScanMode = normalizeScanMode(scan_mode)
  const requestedBaseSha = typeof base_sha === 'string' && base_sha.trim() !== ''
    ? base_sha.trim()
    : null
  let resolvedBaseSha: string | null = null

  let changedFilesForScanScope: ChangedFileRecord[] | null = null
  let commitShasForScanTarget: string[] = []

  if (resolvedScanMode === 'incremental') {
    const baseShaCandidate = String(requestedBaseSha ?? '').trim()
    if (!baseShaCandidate) {
      throw new Error('incremental scan requires base_sha.')
    }
    if (baseShaCandidate === resolvedHeadSha) {
      throw new Error('incremental scan requires base_sha != head_sha.')
    }

    const reachableBaseSha = await getRepositoryRefSha(octokit, {
      owner_login: repo.owner_login,
      repo_name: repo.repo_name,
      ref: baseShaCandidate
    }).catch(() => '')
    if (!reachableBaseSha) {
      throw new Error('incremental scan base_sha is unreachable.')
    }
    resolvedBaseSha = reachableBaseSha

    const windowValid = await isAncestorCommit({
      octokit,
      repo,
      base_sha: resolvedBaseSha,
      head_sha: resolvedHeadSha
    }).catch(() => false)
    if (!windowValid) {
      throw new Error('incremental scan window is invalid.')
    }

    let incrementalResult: { changed_files: ChangedFileRecord[], commit_shas: string[] }
    try {
      incrementalResult = await materializeIncrementalArtifacts({
        octokit,
        repo,
        incremental_window_path,
        history_path,
        run_id,
        event_type,
        base_sha: resolvedBaseSha,
        head_sha: resolvedHeadSha
      })
    } catch (error) {
      throw new Error(
        `incremental artifacts generation failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }

    changedFilesForScanScope = incrementalResult.changed_files
    commitShasForScanTarget = incrementalResult.commit_shas
    if (incrementalResult.changed_files.length > MAX_INCREMENTAL_FILES) {
      throw new Error(
        `incremental diff too large: changed files ${incrementalResult.changed_files.length} exceeds limit ${MAX_INCREMENTAL_FILES}.`
      )
    }
  }

  const historyRefs = resolvedScanMode === 'incremental' && typeof resolvedBaseSha === 'string' && resolvedBaseSha.trim() !== ''
    ? [resolvedBaseSha, resolvedHeadSha]
    : [resolvedHeadSha]
  await materializeWorkspace(octokit, repo, workspace_path, historyRefs)
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: resolvedScanMode === 'incremental'
  })

  if (resolvedScanMode === 'full') {
    await writeJsonArtifact(path.join(history_path, 'scan-window.json'), {
      run_id,
      event_type: event_type,
      scan_mode: 'full',
      base_sha: resolvedBaseSha,
      head_sha: resolvedHeadSha,
      generated_at: new Date().toISOString()
    })
  }

  const input: RepositoryReviewInput = {
    contract_version: 'v4',
    input_bundle_uri: input_bundle_root,
    review_intent: {
      objective: 'audit',
      ...(repair_mode ? { repair_mode } : {})
    },
    scan_target: {
      target_branch: targetBranchForResolution,
      default_branch: repo.default_branch,
      event_type,
      scan_mode: resolvedScanMode,
      base_sha: resolvedBaseSha,
      head_sha: resolvedHeadSha,
      commit_shas: commitShasForScanTarget
    },
    scan_scope: {
      max_file_bytes: 200000,
      paths_ignore: Array.isArray(paths_ignore) ? paths_ignore : [],
      incremental_changed_files: Array.isArray(changedFilesForScanScope)
        ? changedFilesForScanScope.map((item) => ({
          path: item.path,
          status: item.status,
          previous_path: item.previous_path
        }))
        : []
    }
  }

  const input_path = path.join(input_bundle_root, 'repository-review-input.json')
  await writeJsonArtifact(input_path, input)

  return {
    run_id,
    repo,
    workspace_ref: resolvedHeadSha,
    input,
    input_path,
    input_bundle_root
  }
}
