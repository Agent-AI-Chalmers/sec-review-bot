// Resolving a repository's installation client, in one place.
//
// This logic was copied into three call sites (the preparation coordinator, the publication
// coordinator, and repository-dispatch), two of which returned `Promise<unknown>`. Callers then
// cast the result back to `Octokit` immediately, which is exactly where a wrong shape
// should be caught. One implementation keeps the ownership rule (`splitRepoFullName`) and the
// return type together.
import type { App } from 'octokit'

import type { Octokit } from 'octokit'
import { splitRepoFullName } from './repository-service.js'

/** The installation-scoped client for a repository this app is installed on.
 *
 * A repository the app is not installed on makes `getRepoInstallation` answer 404, which
 * propagates: callers treat that as "no access" rather than as a client that would then fail on
 * every individual call. */
export async function installationOctokitForRepo(
  app: Pick<App, 'octokit' | 'getInstallationOctokit'>,
  repoFullName: string
): Promise<Octokit> {
  const { owner_login, repo_name } = splitRepoFullName(repoFullName)
  const installation = await app.octokit.rest.apps.getRepoInstallation({
    owner: owner_login,
    repo: repo_name
  })
  return await app.getInstallationOctokit(installation.data.id)
}
