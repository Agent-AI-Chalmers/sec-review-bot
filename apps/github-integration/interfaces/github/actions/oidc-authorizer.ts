import { createRemoteJWKSet, jwtVerify } from 'jose'

const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const GITHUB_ACTIONS_OIDC_JWKS_URL = new URL(`${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`)
const REPOSITORY_REVIEW_OIDC_AUDIENCE = 'sec-review-bot'
const ALLOWED_REPOSITORY_REVIEW_EVENTS = new Set(['workflow_dispatch', 'schedule'])
const REPOSITORY_REVIEW_WORKFLOW_PATH = '.github/workflows/sec-review-bot.yml'

const githubActionsJwks = createRemoteJWKSet(GITHUB_ACTIONS_OIDC_JWKS_URL)

export interface GitHubActionsOidcClaims {
  repository?: string
  ref?: string
  event_name?: string
  workflow_ref?: string
  [key: string]: unknown
}

export type GitHubActionsOidcVerifier = (token: string) => Promise<GitHubActionsOidcClaims>

export class RepositoryReviewOidcError extends Error {
  constructor (
    message: string,
    readonly status_code: 401 | 403 = 403
  ) {
    super(message)
    this.name = 'RepositoryReviewOidcError'
  }
}

export async function verifyGitHubActionsOidcToken (token: string): Promise<GitHubActionsOidcClaims> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audience: REPOSITORY_REVIEW_OIDC_AUDIENCE
  })

  return payload as GitHubActionsOidcClaims
}

function normalizeHeaderValue (value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return null
  }
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

function branchNameFromRef (ref: unknown): string | null {
  const value = typeof ref === 'string' ? ref.trim() : ''
  if (!value.startsWith('refs/heads/')) {
    return null
  }
  return value.slice('refs/heads/'.length)
}

function workflowRefMatchesRepositoryReviewWorkflow (value: unknown, repo_full_name: string, target_branch: string): boolean {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === `${repo_full_name}/${REPOSITORY_REVIEW_WORKFLOW_PATH}@refs/heads/${target_branch}`
}

export async function authorizeRepositoryReviewDispatchOidc ({
  headers,
  payload_repo_full_name,
  payload_target_branch,
  verifier = verifyGitHubActionsOidcToken
}: {
  headers: Record<string, string | string[] | undefined>
  payload_repo_full_name: string
  payload_target_branch: string
  verifier?: GitHubActionsOidcVerifier
}): Promise<GitHubActionsOidcClaims> {
  const token = normalizeHeaderValue(headers['x-sec-review-bot-oidc-token'])
  if (token === null) {
    throw new RepositoryReviewOidcError('Missing GitHub Actions OIDC token.', 401)
  }

  let claims: GitHubActionsOidcClaims
  try {
    claims = await verifier(token)
  } catch (error) {
    throw new RepositoryReviewOidcError(
      `Invalid GitHub Actions OIDC token: ${error instanceof Error ? error.message : String(error)}`,
      401
    )
  }

  if (claims.repository !== payload_repo_full_name) {
    throw new RepositoryReviewOidcError('OIDC repository does not match repo_full_name.')
  }

  if (!ALLOWED_REPOSITORY_REVIEW_EVENTS.has(String(claims.event_name ?? ''))) {
    throw new RepositoryReviewOidcError('OIDC event is not allowed for repository review dispatch.')
  }

  const refBranch = branchNameFromRef(claims.ref)
  if (refBranch === null || refBranch !== payload_target_branch) {
    throw new RepositoryReviewOidcError('OIDC ref does not match target_branch.')
  }

  if (!workflowRefMatchesRepositoryReviewWorkflow(claims.workflow_ref, payload_repo_full_name, payload_target_branch)) {
    throw new RepositoryReviewOidcError('OIDC workflow is not allowed for repository review dispatch.')
  }

  return claims
}
