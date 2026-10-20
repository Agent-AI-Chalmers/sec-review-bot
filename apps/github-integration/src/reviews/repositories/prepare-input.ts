import { CONTRACT_VERSION } from '../../runner/contract-version.js'
import fs from 'fs/promises'
import path from 'path'

import {
  getRepositoryRefSha,
  splitRepoFullName
} from '../../github/repository-service.js'
import type { TrustedDefaultBranch } from '../../github/default-branch-service.js'
import type { Octokit } from 'octokit'
import type {
  InputBundleArtifactRef,
  TestChangesPolicy,
  RepositoryReviewInput
} from '../../runner/input.js'
import {
  MAX_SCAN_SCOPE_INCREMENTAL_CHANGED_FILES,
  MAX_SCAN_TARGET_COMMIT_SHAS
} from '../../runner/input.js'
import { getInstallationAccessToken } from '../../github/installation-auth.js'
import { materializeWorkspaceWithCommitHistory } from '../../artifacts/git-workspace.js'
import {
  isAncestorCommit,
  materializeIncrementalArtifacts,
  type ChangedFileRecord
} from './incremental-artifacts.js'
import {
  archiveInputBundleAndPublish,
  buildGitRemoteUrl,
  createInputBundleRoot,
  ensureCleanDirectory,
  finalizeInputBundleWorkspace,
  readSetupDeclaration
} from '../shared/input-bundle.js'

interface RepositoryContext {
  owner_login: string
  repo_name: string
  repo_full_name: string
  default_branch: string
}

type RepositoryScanMode = 'full' | 'incremental'

function normalizeScanMode(value: unknown): RepositoryScanMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'full' || raw === 'incremental') {
    return raw
  }
  throw new Error(`Unsupported repository scan_mode: ${String(value)}`)
}

async function materializeWorkspace(
  octokit: Octokit,
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

async function writeJsonArtifact(
  artifact_path: string,
  value: unknown
): Promise<void> {
  await fs.writeFile(artifact_path, JSON.stringify(value, null, 2), 'utf8')
}

export async function prepareRepositoryReviewInput({
  run_id,
  octokit,
  repo_full_name,
  trusted_default_branch,
  target_branch = null,
  scan_mode,
  base_sha = null,
  head_sha = null,
  event_type = 'manual',
  paths_ignore = [],
  test_changes = null
}: {
  run_id: string
  octokit: Octokit
  repo_full_name: string
  trusted_default_branch: TrustedDefaultBranch
  target_branch?: string | null
  scan_mode: RepositoryScanMode
  base_sha?: string | null
  head_sha?: string | null
  event_type?: 'manual' | 'scheduled'
  paths_ignore?: string[]
  test_changes?: TestChangesPolicy | null
}): Promise<{
  run_id: string
  repo: RepositoryContext
  workspace_ref: string
  input: RepositoryReviewInput
  input_path: string
  input_bundle_root: string
}> {
  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const repo: RepositoryContext = {
    owner_login,
    repo_name,
    repo_full_name,
    default_branch: trusted_default_branch.default_branch
  }
  const targetBranchForResolution =
    target_branch || trusted_default_branch.default_branch
  const headResolutionTarget = head_sha || targetBranchForResolution
  const resolvedHeadSha = await getRepositoryRefSha(octokit, {
    owner_login: repo.owner_login,
    repo_name: repo.repo_name,
    ref: headResolutionTarget
  })
  const input_bundle_root = createInputBundleRoot(
    repo.repo_full_name,
    'repository-review',
    resolvedHeadSha,
    run_id
  )
  const workspace_path = path.join(input_bundle_root, 'workspace')
  const incremental_window_path = path.join(
    input_bundle_root,
    'incremental-window'
  )
  const history_path = path.join(input_bundle_root, 'history')

  // A supplied run ID is reused after uncertain submission failures. Remove
  // partial files from the previous preparation before rebuilding the bundle.
  await ensureCleanDirectory(input_bundle_root)
  await Promise.all([
    fs.mkdir(incremental_window_path, { recursive: true }),
    fs.mkdir(history_path, { recursive: true })
  ])

  const resolvedScanMode = normalizeScanMode(scan_mode)
  const requestedBaseSha =
    typeof base_sha === 'string' && base_sha.trim() !== ''
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
  }

  const historyRefs =
    resolvedScanMode === 'incremental' &&
    typeof resolvedBaseSha === 'string' &&
    resolvedBaseSha.trim() !== ''
      ? [resolvedBaseSha, resolvedHeadSha]
      : [resolvedHeadSha]
  await materializeWorkspace(octokit, repo, workspace_path, historyRefs)

  if (
    resolvedScanMode === 'incremental' &&
    typeof resolvedBaseSha === 'string' &&
    resolvedBaseSha.trim() !== ''
  ) {
    let incrementalResult: {
      changed_files: ChangedFileRecord[]
      commit_shas: string[]
    }
    try {
      incrementalResult = await materializeIncrementalArtifacts({
        workspace_path,
        incremental_window_path,
        history_path,
        base_sha: resolvedBaseSha,
        head_sha: resolvedHeadSha
      })
    } catch (error) {
      throw new Error(
        `incremental artifacts generation failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }

    // Refuse an oversized window here rather than at transport. Every entry below is inlined
    // into the workflow input, so an unbounded list would cross Temporal and be persisted, and
    // the failure would surface as an infrastructure error far from its cause. The limits match
    // `maxItems` in the v6 schemas, which is where the boundary is defined.
    if (
      incrementalResult.changed_files.length >
      MAX_SCAN_SCOPE_INCREMENTAL_CHANGED_FILES
    ) {
      throw new Error(
        `incremental window is too large: ${incrementalResult.changed_files.length} changed ` +
          `files exceeds the limit of ${MAX_SCAN_SCOPE_INCREMENTAL_CHANGED_FILES}`
      )
    }
    if (incrementalResult.commit_shas.length > MAX_SCAN_TARGET_COMMIT_SHAS) {
      throw new Error(
        `incremental window is too large: ${incrementalResult.commit_shas.length} commits ` +
          `exceeds the limit of ${MAX_SCAN_TARGET_COMMIT_SHAS}`
      )
    }

    changedFilesForScanScope = incrementalResult.changed_files
    commitShasForScanTarget = incrementalResult.commit_shas
  }
  // Trusted default branch (not the user-selectable target_branch): its head SHA
  // was resolved once upstream; read the setup declaration from it through the
  // Contents API, whose auth rides on `octokit`.
  const setup_declaration = await readSetupDeclaration({
    octokit,
    default_sha: trusted_default_branch.head_sha,
    owner_login: repo.owner_login,
    repo_name: repo.repo_name
  })
  await finalizeInputBundleWorkspace({
    input_bundle_root,
    workspace_path,
    include_incremental_window: resolvedScanMode === 'incremental'
  })

  // One writer for the run's window. The incremental scan contributes the only field a full scan
  // cannot report: how many files the window touched.
  await writeJsonArtifact(path.join(history_path, 'scan-window.json'), {
    run_id,
    event_type,
    scan_mode: resolvedScanMode,
    base_sha: resolvedBaseSha,
    head_sha: resolvedHeadSha,
    ...(changedFilesForScanScope === null
      ? {}
      : { changed_file_count: changedFilesForScanScope.length }),
    generated_at: new Date().toISOString()
  })

  // The bundle is published only after the input that references it fits, so a failure here
  // cannot leave an unreferenced immutable bundle behind.
  const { input } = await archiveInputBundleAndPublish<RepositoryReviewInput>({
    input_bundle_root,
    include_incremental_window: resolvedScanMode === 'incremental',
    run_id,
    workflow: 'repository review',
    build_input: (
      reference: InputBundleArtifactRef
    ): RepositoryReviewInput => ({
      contract_version: CONTRACT_VERSION,
      input_bundle: reference,
      review_intent: {
        objective: 'audit',
        ...(test_changes ? { test_changes } : {})
      },
      scan_target: {
        target_branch: targetBranchForResolution,
        default_branch: trusted_default_branch.default_branch,
        event_type,
        scan_mode: resolvedScanMode,
        base_sha: resolvedBaseSha,
        head_sha: resolvedHeadSha,
        commit_shas: commitShasForScanTarget
      },
      scan_scope: {
        paths_ignore: Array.isArray(paths_ignore) ? paths_ignore : [],
        incremental_changed_files: Array.isArray(changedFilesForScanScope)
          ? changedFilesForScanScope.map((item) => ({
              path: item.path,
              status: item.status,
              previous_path: item.previous_path
            }))
          : []
      },
      ...(setup_declaration ? { setup_declaration } : {})
    })
  })

  const input_path = path.join(
    input_bundle_root,
    'repository-review-input.json'
  )
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
