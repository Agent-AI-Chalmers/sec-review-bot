import { expect, test } from 'vitest'

import {
  fetchRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError,
  RepositoryTriggerConfigError
} from '../../src/github/repo-config-service.js'
import type { Octokit } from 'octokit'
import { fakeGitHub, githubFile, githubJson, type RecordedRequest } from '../github-client.js'

type Content_by_path = Record<string, string | Error>

function createOctokitWithContent(contentByPath: Content_by_path = {}): {
  octokit: Octokit
  requests: RecordedRequest[]
} {
  return fakeGitHub(({ url }) => {
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1] ?? '')
    const source = contentByPath[path]
    // A missing entry is a real 404, which is what GitHub answers for an absent file.
    if (source === undefined) {
      return githubJson({ message: 'Not Found' }, 404)
    }
    if (source instanceof Error) {
      return githubJson({ message: source.message }, 500)
    }
    return githubFile(source, path)
  })
}

const CONFIG_PATH = '.sec-review/config.yml'

test('fetchRepositoryTriggerConfig falls back to manual_only when config file is missing', async () => {
  const { octokit } = createOctokitWithContent({})

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  expect(config).toStrictEqual({
    trigger_mode: 'manual_only',
    paths_ignore: [],
    path: null,
    ref: 'main',
    source: 'default'
  })
  expect(isAutomaticTriggerModeEnabled(config)).toBe(false)
})

test('fetchRepositoryTriggerConfig parses automatic trigger mode from repository config', async () => {
  const { octokit } = createOctokitWithContent({
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

  expect(config).toStrictEqual({
    trigger_mode: 'automatic',
    paths_ignore: ['frontend/src/assets', '**/*.min.js'],
    path: CONFIG_PATH,
    ref: 'main',
    source: 'repository-config'
  })
  expect(isAutomaticTriggerModeEnabled(config)).toBe(true)
})

test('fetchRepositoryTriggerConfig parses manual_only trigger mode from repository config', async () => {
  const { octokit } = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: manual_only'].join('\n')
  })

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  expect(config).toStrictEqual({
    trigger_mode: 'manual_only',
    paths_ignore: [],
    path: CONFIG_PATH,
    ref: 'main',
    source: 'repository-config'
  })
  expect(isAutomaticTriggerModeEnabled(config)).toBe(false)
})

test('fetchRepositoryTriggerConfig throws RepositoryTriggerConfigError for invalid YAML', async () => {
  const { octokit } = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: [broken'
  })

  await expect(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    })
  ).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof RepositoryTriggerConfigError)) {
      return false
    }
    expect(isRepositoryTriggerConfigError(error)).toBe(true)
    expect(error instanceof RepositoryTriggerConfigError).toBe(true)
    expect(error.reason).toBe('invalid-yaml')
    expect(error.owner_login).toBe('octo')
    expect(error.repo_name).toBe('repo')
    expect(error.ref).toBe('main')
    expect(error.path).toBe(CONFIG_PATH)
    return true
  })
})

test('fetchRepositoryTriggerConfig throws for missing sec_review_bot.trigger_mode', async () => {
  const { octokit } = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: {}'
  })

  await expect(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    })
  ).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof RepositoryTriggerConfigError)) {
      return false
    }
    expect(isRepositoryTriggerConfigError(error)).toBe(true)
    expect(error.reason).toBe('missing-trigger-mode')
    return true
  })
})

test('fetchRepositoryTriggerConfig throws for invalid trigger_mode enum value', async () => {
  const { octokit } = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: always_on'].join('\n')
  })

  await expect(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    })
  ).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof RepositoryTriggerConfigError)) {
      return false
    }
    expect(isRepositoryTriggerConfigError(error)).toBe(true)
    expect(error.reason).toBe('invalid-trigger-mode')
    return true
  })
})

test('fetchRepositoryTriggerConfig throws for invalid paths_ignore shape', async () => {
  const { octokit } = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic', '  paths_ignore: invalid'].join(
      '\n'
    )
  })

  await expect(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    })
  ).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof RepositoryTriggerConfigError)) {
      return false
    }
    expect(isRepositoryTriggerConfigError(error)).toBe(true)
    expect(error.reason).toBe('invalid-paths-ignore')
    return true
  })
})

test('reads the .sec-review/config.yml path', async () => {
  const { octokit, requests } = createOctokitWithContent({
    [CONFIG_PATH]: ['sec_review_bot:', '  trigger_mode: automatic'].join('\n')
  })

  const config = await fetchRepositoryTriggerConfig(octokit, {
    owner_login: 'octo',
    repo_name: 'repo',
    ref: 'main'
  })

  expect(config.trigger_mode).toBe('automatic')
  expect(config.path).toBe(CONFIG_PATH)
  // The Contents API path is part of the request URL, so the recorded request proves which file
  // was read without replacing the client's method.
  expect(requests).toHaveLength(1)
  expect.assert(
    decodeURIComponent(new URL(requests[0]!.url).pathname).endsWith(`/contents/${CONFIG_PATH}`),
    requests[0]!.url
  )
})

test('invalid YAML in the config path is rejected', async () => {
  const { octokit } = createOctokitWithContent({
    [CONFIG_PATH]: 'sec_review_bot: [broken'
  })

  await expect(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    })
  ).rejects.toSatisfy(
    (error: unknown) => isRepositoryTriggerConfigError(error) && error.path === CONFIG_PATH
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

  await expect(
    fetchRepositoryTriggerConfig(octokit, {
      owner_login: 'octo',
      repo_name: 'repo',
      ref: 'main'
    })
  ).rejects.toSatisfy(
    (error: unknown) => isRepositoryTriggerConfigError(error) && error.reason === 'invalid-content'
  )
})
