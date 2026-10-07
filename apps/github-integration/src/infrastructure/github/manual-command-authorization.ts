import type { GitHubAppOctokit } from './octokit.js'

export type RepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin' | 'unknown'

const PERMISSION_RANK: Record<RepositoryPermission, number> = {
  unknown: 0,
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5
}

export interface ManualCommandAuthorizationDecision {
  allowed: boolean
  sender_login: string | null
  permission: RepositoryPermission
  required_permission: 'write'
  reason: 'allowed' | 'missing-sender' | 'insufficient-permission' | 'permission-lookup-failed'
}

export function normalizeRepositoryPermission (value: unknown): RepositoryPermission {
  if (
    value === 'none' ||
    value === 'read' ||
    value === 'triage' ||
    value === 'write' ||
    value === 'maintain' ||
    value === 'admin'
  ) {
    return value
  }

  return 'unknown'
}

export async function authorizeManualCommentCommand ({
  octokit,
  owner_login,
  repo_name,
  sender_login
}: {
  octokit: GitHubAppOctokit
  owner_login: string
  repo_name: string
  sender_login: string | undefined
}): Promise<ManualCommandAuthorizationDecision> {
  const normalizedSender = typeof sender_login === 'string' && sender_login.trim() !== ''
    ? sender_login.trim()
    : null

  if (!normalizedSender) {
    return {
      allowed: false,
      sender_login: null,
      permission: 'unknown',
      required_permission: 'write',
      reason: 'missing-sender'
    }
  }

  try {
    const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: owner_login,
      repo: repo_name,
      username: normalizedSender
    })
    const permission = normalizeRepositoryPermission(response.data.permission)
    const allowed = PERMISSION_RANK[permission] >= PERMISSION_RANK.write

    return {
      allowed,
      sender_login: normalizedSender,
      permission,
      required_permission: 'write',
      reason: allowed ? 'allowed' : 'insufficient-permission'
    }
  } catch {
    return {
      allowed: false,
      sender_login: normalizedSender,
      permission: 'unknown',
      required_permission: 'write',
      reason: 'permission-lookup-failed'
    }
  }
}
