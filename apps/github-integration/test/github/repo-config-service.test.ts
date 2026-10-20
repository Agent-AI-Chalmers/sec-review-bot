import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError,
  RepositoryTriggerConfigError
} from '../../src/github/repo-config-service.js'
import type { Octokit } from 'octokit'
import { fakeGitHub, githubFile, githubJson } from '../github-client.js'

type Content_by_path = Record<string, string | Error>

function createOctokitWithContent(
  contentByPath: Content_by_path = {}
): Octokit {
  return fakeGitHub(({ url }) => {
    const path = decodeURIComponent(
      new URL(url).pathname.split('/contents/')[1] ?? ''
    )
    const source = contentByPath[path]
    // A missing entry is a real 404, which is what GitHub answers for an absent file.
    if (source === undefined) return githubJson({ message: 'Not Found' }, 404)
    if (source instanceof Error)
      return githubJson({ message: source.message }, 500)
    return githubFile(source, path)
  }).octokit
}

const CONFIG_PATH = '.sec-review/config.yml'

test('fetchRepositoryTriggerConfig falls back to manual_only when config file is missing', async () => {
  const octokit = createOctokitWithContent({})

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  assert.deepStrictEqual(config, {
    trigger_mode: 'manual_only',
    paths_ignore: [],
    path: null,
    ref: 'main',
    source: 'default'
  })
  assert.strictEqual(isAutomaticTriggerModeEnabled(config), false)
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

  assert.deepStrictEqual(config, {
    trigger_mode: 'automatic',
    paths_ignore: ['frontend/src/assets', '**/*.min.js'],
    path: CONFIG_PATH,
    ref: 'main',
    source: 'repository-config'
  })
  assert.strictEqual(isAutomaticTriggerModeEnabled(config), true)
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

  assert.deepStrictEqual(config, {
    trigger_mode: 'manual_only',
    paths_ignore: [],
    path: CONFIG_PATH,
    ref: 'main',
    source: 'repository-config'
  })
  assert.strictEqual(isAutomaticTriggerModeEnabled(config), false)
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
      assert.strictEqual(isRepositoryTriggerConfigError(error), true)
      assert.strictEqual(error instanceof RepositoryTriggerConfigError, true)
      assert.strictEqual(error.reason, 'invalid-yaml')
      assert.strictEqual(error.owner_login, 'octo')
      assert.strictEqual(error.repo_name, 'repo')
      assert.strictEqual(error.ref, 'main')
      assert.strictEqual(error.path, CONFIG_PATH)
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
      assert.strictEqual(isRepositoryTriggerConfigError(error), true)
      assert.strictEqual(error.reason, 'missing-trigger-mode')
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
      assert.strictEqual(isRepositoryTriggerConfigError(error), true)
      assert.strictEqual(error.reason, 'invalid-trigger-mode')
      return true
    }
  )
})

test('fetchRepositoryTriggerConfig throws for invalid paths_ignore shape', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: [
      'sec_review_bot:',
      '  trigger_mode: automatic',
      '  paths_ignore: invalid'
    ].join('\n')
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
      assert.strictEqual(isRepositoryTriggerConfigError(error), true)
      assert.strictEqual(error.reason, 'invalid-paths-ignore')
      return true
    }
  )
})

test('reads the .sec-review/config.yml path', async () => {
  const readPaths: string[] = []
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic'].join('\n')
  })
  const originalGetContent = (
    octokit as unknown as {
      rest: {
        repos: { getContent: (args: { path: string }) => Promise<unknown> }
      }
    }
  ).rest.repos.getContent
  ;(
    octokit as unknown as {
      rest: {
        repos: { getContent: (args: { path: string }) => Promise<unknown> }
      }
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

  assert.strictEqual(config.trigger_mode, 'automatic')
  assert.strictEqual(config.path, CONFIG_PATH)
  assert.deepStrictEqual(readPaths, [CONFIG_PATH])
})

test('invalid YAML in the config path is rejected', async () => {
  const octokit = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: [broken'
  })

  await assert.rejects(
    () =>
      fetchRepositoryTriggerConfig(octokit, {
        owner_login: 'octo',
        repo_name: 'repo',
        ref: 'main'
      }),
    (error: unknown) =>
      isRepositoryTriggerConfigError(error) && error.path === CONFIG_PATH
  )
})

test('fetchRepositoryTriggerConfig rejects a non-file entry instead of parsing it', async () => {
  // A symlinked config resolves to a single object whose `content` is the
  // target path, not the file body. It must never be parsed as YAML. The entry
  // exists but is not a regular file, so the config read fails strictly (like a
  // present-but-invalid config) rather than silently parsing the target path or
  // falling back to defaults.
  const octokit = fakeGitHub(() =>
    githubJson({
      type: 'symlink',
      target: '.sec-review/other.yml',
      content: Buffer.from('.sec-review/other.yml', 'utf-8').toString('base64')
    })
  ).octokit

  await assert.rejects(
    () =>
      fetchRepositoryTriggerConfig(octokit, {
        owner_login: 'octo',
        repo_name: 'repo',
        ref: 'main'
      }),
    (error: unknown) =>
      isRepositoryTriggerConfigError(error) &&
      error.reason === 'invalid-content'
  )
})
