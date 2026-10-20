// Covers the one place a repository is turned into its installation client.
//
// Before this file, the function was only exercised indirectly: the coordinator tests inject
// `deps.getInstallationOctokit`, and `fakeApp({ installationOctokit })` replaces the App's own
// token-exchange, so nothing asserted that the *installation id* from the lookup is the one handed
// to `getInstallationOctokit`, nor that a missing installation propagates as a 404.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { App } from 'octokit'

import { installationOctokitForRepo } from '../../src/github/installation-client.js'
import { splitRepoFullName } from '../../src/github/repository-service.js'
import { fakeGitHub, githubJson } from '../github-client.js'
import { fakeApp } from '../github-app-stubs.js'

/** A minimal App shape: the lookup answer plus a replacement client factory. */
function appDouble(options: {
  installationId?: number
  lookupStatus?: number
  installationOctokit: Awaited<ReturnType<typeof fakeGitHub>>['octokit']
  onGetInstallationOctokit?: (id: number) => void
}): Pick<App, 'octokit' | 'getInstallationOctokit'> {
  const { octokit } = fakeGitHub(() =>
    options.lookupStatus === undefined
      ? githubJson({ id: options.installationId ?? 123 })
      : githubJson({ message: 'nope' }, options.lookupStatus)
  )
  return {
    octokit,
    getInstallationOctokit: async (id: number) => {
      options.onGetInstallationOctokit?.(id)
      return options.installationOctokit
    }
  }
}

test('the installation id from the lookup is the one used to mint the client', async () => {
  // The id matters: asking for a client with the wrong installation would hand back a client
  // scoped to a different installation's repositories. This pins the value passed through.
  const seen: number[] = []
  const client = fakeGitHub(() => githubJson({})).octokit
  const app = appDouble({
    installationId: 4242,
    installationOctokit: client,
    onGetInstallationOctokit: (id) => seen.push(id)
  })

  const resolved = await installationOctokitForRepo(app, 'octo/example')

  assert.strictEqual(resolved, client)
  assert.deepStrictEqual(seen, [4242])
})

test('the repository is split into owner and repo for the installation lookup', async () => {
  // The lookup endpoint takes owner and repo separately; sending the full name as either would
  // query the wrong path. This asserts the parsed pair reaches the request.
  const { octokit, requests } = fakeGitHub(() => githubJson({ id: 7 }))
  const app: Pick<App, 'octokit' | 'getInstallationOctokit'> = {
    octokit,
    getInstallationOctokit: async (_id: number) => octokit
  }

  await installationOctokitForRepo(app, 'octo/example')

  assert.strictEqual(requests.length, 1)
  assert.strictEqual(
    new URL(requests[0]!.url).pathname,
    '/repos/octo/example/installation'
  )
})

test('a repository with no installation propagates the 404', async () => {
  // A 404 means "this app is not installed here". It must surface as a failure, not as a client
  // that would then fail on every individual call.
  const client = fakeGitHub(() => githubJson({})).octokit
  const app = appDouble({ lookupStatus: 404, installationOctokit: client })

  await assert.rejects(
    () => installationOctokitForRepo(app, 'attacker/repo'),
    (error: { status?: number }) => error.status === 404
  )
})

test('an invalid repository name is rejected before any request', async () => {
  // The name is parsed by the same function the rest of the connector uses, so a malformed value
  // fails here rather than being split opportunistically into a different repository.
  const { octokit, requests } = fakeGitHub(() => githubJson({ id: 1 }))
  const app: Pick<App, 'octokit' | 'getInstallationOctokit'> = {
    octokit,
    getInstallationOctokit: async (_id: number) => octokit
  }

  await assert.rejects(() => installationOctokitForRepo(app, 'octo'))
  assert.deepStrictEqual(requests, [])
  assert.throws(() => splitRepoFullName('octo'))
})

test('a real App answers the lookup through the installed client factory', async () => {
  // This is the closest the suite gets to the real token exchange: the App itself performs the
  // `apps.getRepoInstallation` request (over a fake transport) and its own
  // `getInstallationOctokit` is called with the id it answered. The token minting inside is not
  // reproduced - that needs a real GitHub private key and installation - so this covers the
  // wiring, not the signing.
  const client = fakeGitHub(() => githubJson({})).octokit
  let requestedId: number | undefined
  const { app } = fakeApp({ respond: () => githubJson({ id: 99 }) })
  app.getInstallationOctokit = async (id: number) => {
    requestedId = id
    return client
  }

  const resolved = await installationOctokitForRepo(app, 'octo/example')

  assert.strictEqual(resolved, client)
  assert.strictEqual(requestedId, 99)
})
