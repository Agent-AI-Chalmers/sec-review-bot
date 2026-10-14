import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError,
  RepositoryTriggerConfigError
} from '../../src/github/repo-config-service.js'
import type { GitHubAppOctokit } from '../../src/github/octokit.js'

interface TestErrorWithStatus extends Error {
  status?: number
}

type Content_by_path = Record<string, string | Error>

function createOctokitWithContent(contentByPath: Content_by_path = {}): GitHubAppOctokit {
  return {
    auth: async () => ({}),
    graphql: async () => ({}),
    request: async () => ({ data: {} }),
    rest: {
      git: {},
      issues: {},
      pulls: {},
      repos: {
        getContent: async ({ path }: { path: string }) => {
          if (!(path in contentByPath)) {
            const error: TestErrorWithStatus = new Error('Not found')
            error.status = 404
            throw error
          }

          const source = contentByPath[path]
          if (typeof source === 'undefined') {
            const error: TestErrorWithStatus = new Error('Not found')
            error.status = 404
            throw error
          }

          if (source instanceof Error) {
            throw source
          }

          return {
            data: {
              content: Buffer.from(source, 'utf-8').toString('base64')
            }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit
}

const CONFIG_PATH = '.sec-review/config.yml'
const LEGACY_CONFIG_PATH = '.github/sec-review-bot.yml'

test('fetchRepositoryTriggerConfig falls back to manual_only when config file is missing', async () => {
  const octokit = createOctokitWithContent({})

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  assert.deepEqual(config, {
    trigger_mode: 'manual_only',
    paths_ignore: [],
    path: null,
    ref: 'main',
    source: 'default'
  })
  assert.equal(isAutomaticTriggerModeEnabled(config), false)
})

test('fetchRepositoryTriggerConfig parses automatic trigger mode from repository config', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: [
      'sec_review_bot:',
      '  trigger_mode: automatic',
      '  paths_ignore:',
      "    - 'frontend/src/assets'",
      "    - '**/*.min.js'"
    ].join('\n')
  })

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  assert.deepEqual(config, {
    trigger_mode: 'automatic',
    paths_ignore: ['frontend/src/assets', '**/*.min.js'],
    path: CONFIG_PATH,
    ref: 'main',
    source: 'repository-config'
  })
  assert.equal(isAutomaticTriggerModeEnabled(config), true)
})

test('fetchRepositoryTriggerConfig parses manual_only trigger mode from repository config', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: manual_only'].join('\n')
  })

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  assert.deepEqual(config, {
    trigger_mode: 'manual_only',
    paths_ignore: [],
    path: CONFIG_PATH,
    ref: 'main',
    source: 'repository-config'
  })
  assert.equal(isAutomaticTriggerModeEnabled(config), false)
})

test('fetchRepositoryTriggerConfig throws RepositoryTriggerConfigError for invalid YAML', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: [broken'
  })

  await assert.rejects(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    }),
    (error: unknown) => {
      if (!(error instanceof RepositoryTriggerConfigError)) {
        return false
      }
      assert.equal(isRepositoryTriggerConfigError(error), true)
      assert.equal(error instanceof RepositoryTriggerConfigError, true)
      assert.equal(error.reason, 'invalid-yaml')
      assert.equal(error.owner_login, 'octo')
      assert.equal(error.repo_name, 'repo')
      assert.equal(error.ref, 'main')
      assert.equal(error.path, CONFIG_PATH)
      return true
    }
  )
})

test('fetchRepositoryTriggerConfig throws for missing sec_review_bot.trigger_mode', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: {}'
  })

  await assert.rejects(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    }),
    (error: unknown) => {
      if (!(error instanceof RepositoryTriggerConfigError)) {
        return false
      }
      assert.equal(isRepositoryTriggerConfigError(error), true)
      assert.equal(error.reason, 'missing-trigger-mode')
      return true
    }
  )
})

test('fetchRepositoryTriggerConfig throws for invalid trigger_mode enum value', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: always_on'].join('\n')
  })

  await assert.rejects(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    }),
    (error: unknown) => {
      if (!(error instanceof RepositoryTriggerConfigError)) {
        return false
      }
      assert.equal(isRepositoryTriggerConfigError(error), true)
      assert.equal(error.reason, 'invalid-trigger-mode')
      return true
    }
  )
})

test('fetchRepositoryTriggerConfig throws for invalid paths_ignore shape', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic', '  paths_ignore: invalid'].join(
      '\n'
    )
  })

  await assert.rejects(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    }),
    (error: unknown) => {
      if (!(error instanceof RepositoryTriggerConfigError)) {
        return false
      }
      assert.equal(isRepositoryTriggerConfigError(error), true)
      assert.equal(error.reason, 'invalid-paths-ignore')
      return true
    }
  )
})

test('reads the new .sec-review/config.yml path and does not touch legacy', async () => {
  const readPaths: string[] = []
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic'].join('\n'),
    [LEGACY_CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: manual_only'].join('\n')
  })
  const originalGetContent = (
    octokit as unknown as {
      rest: { repos: { getContent: (args: { path: string }) => Promise<unknown> } }
    }
  ).rest.repos.getContent
  ;(
    octokit as unknown as {
      rest: { repos: { getContent: (args: { path: string }) => Promise<unknown> } }
    }
  ).rest.repos.getContent = async (args: { path: string }) => {
    readPaths.push(args.path)
    return originalGetContent(args)
  }

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  assert.equal(config.trigger_mode, 'automatic')
  assert.equal(config.path, CONFIG_PATH)
  assert.deepEqual(readPaths, [CONFIG_PATH], 'legacy path must not be read when new path exists')
})

test('falls back to the legacy .github/sec-review-bot.yml path when the new path is missing', async () => {
  const octokit = createOctokitWithContent({
    [LEGACY_CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic'].join('\n')
  })

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  assert.equal(config.trigger_mode, 'automatic')
  assert.equal(config.path, LEGACY_CONFIG_PATH)
  assert.equal(config.source, 'repository-config')
})

test('invalid YAML in the new path does not fall back to legacy', async () => {
  let legacyRead = false
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: [broken',
    [LEGACY_CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic'].join('\n')
  })
  const originalGetContent = (
    octokit as unknown as {
      rest: { repos: { getContent: (args: { path: string }) => Promise<unknown> } }
    }
  ).rest.repos.getContent
  ;(
    octokit as unknown as {
      rest: { repos: { getContent: (args: { path: string }) => Promise<unknown> } }
    }
  ).rest.repos.getContent = async (args: { path: string }) => {
    if (args.path === LEGACY_CONFIG_PATH) legacyRead = true
    return originalGetContent(args)
  }

  await assert.rejects(
    () =>
      fetchRepositoryTriggerConfig(octokit, {
        owner_login: 'octo',
        repo_name: 'repo',
        ref: 'main'
      }),
    (error: unknown) => isRepositoryTriggerConfigError(error) && error.path === CONFIG_PATH
  )
  assert.equal(legacyRead, false, 'invalid new-path config must not fall back to legacy')
})
