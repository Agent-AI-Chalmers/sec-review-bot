import type { Octokit } from 'octokit'

export async function getInstallationAccessToken(
  octokit: Octokit
): Promise<string> {
  const authResult = await octokit.auth({
    type: 'installation'
  })

  const token =
    typeof authResult === 'object' && authResult !== null
      ? (authResult as { token?: unknown }).token
      : undefined

  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(
      'Unable to resolve GitHub App installation token for git materialization.'
    )
  }

  return token.trim()
}
