import { parse as parseYaml } from 'yaml'
import type { GitHubAppOctokit } from './octokit.js'

const CONFIG_PATH = '.github/sec-review-bot.yml'

const MANUAL_ONLY_TRIGGER_MODE = 'manual_only'
const AUTOMATIC_TRIGGER_MODE = 'automatic'
const DEFAULT_TRIGGER_MODE = MANUAL_ONLY_TRIGGER_MODE

type TriggerMode = typeof MANUAL_ONLY_TRIGGER_MODE | typeof AUTOMATIC_TRIGGER_MODE

interface RepositoryTriggerConfig {
  trigger_mode: TriggerMode
  paths_ignore: string[]
  path: string | null
  ref: string | null
  source: 'repository-config' | 'default'
}

interface ParsedSecReviewBotConfig {
  trigger_mode?: unknown
  paths_ignore?: unknown
}

interface RepositoryTriggerConfigErrorOptions {
  owner_login?: string
  repo_name?: string
  ref?: string | undefined
  path?: string
  reason?: string
  cause?: unknown
}

interface RepoGetContentResponse {
  data: {
    content?: string
  } | Array<unknown>
}

interface GitHubLikeError {
  status?: number
  name?: string
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRepositoryConfig (content: string): ParsedSecReviewBotConfig {
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch (error) {
    throw new RepositoryTriggerConfigError('Failed to parse trigger config YAML.', {
      reason: 'invalid-yaml',
      cause: error
    })
  }

  if (!isRecord(parsed) || !isRecord(parsed.sec_review_bot)) {
    throw new RepositoryTriggerConfigError('Missing sec_review_bot section in trigger config.', {
      reason: 'missing-sec-review-bot'
    })
  }

  return parsed.sec_review_bot as ParsedSecReviewBotConfig
}

export class RepositoryTriggerConfigError extends Error {
  owner_login: string | null
  repo_name: string | null
  ref: string | null
  path: string | null
  reason: string

  constructor (message: string, {
    owner_login,
    repo_name,
    ref,
    path,
    reason,
    cause
  }: RepositoryTriggerConfigErrorOptions = {}) {
    super(message, { cause })
    this.name = 'RepositoryTriggerConfigError'
    this.owner_login = owner_login ?? null
    this.repo_name = repo_name ?? null
    this.ref = ref ?? null
    this.path = path ?? CONFIG_PATH
    this.reason = reason ?? 'unknown'
  }
}

export function isRepositoryTriggerConfigError (error: unknown): error is RepositoryTriggerConfigError {
  return error instanceof RepositoryTriggerConfigError ||
    (isRecord(error) && error.name === 'RepositoryTriggerConfigError')
}

function decodeRepositoryFileContent (data: RepoGetContentResponse['data']): string | null {
  if (!isRecord(data) || typeof data.content !== 'string') {
    return null
  }

  return Buffer.from(data.content, 'base64').toString('utf-8')
}

function extractTriggerMode (content: string): TriggerMode {
  const config = parseRepositoryConfig(content)
  const value = config.trigger_mode

  if (typeof value !== 'string') {
    throw new RepositoryTriggerConfigError('Missing sec_review_bot.trigger_mode in trigger config.', {
      reason: 'missing-trigger-mode'
    })
  }

  const normalized = value.trim().toLowerCase()

  if (normalized === AUTOMATIC_TRIGGER_MODE) {
    return AUTOMATIC_TRIGGER_MODE
  }

  if (normalized === MANUAL_ONLY_TRIGGER_MODE) {
    return MANUAL_ONLY_TRIGGER_MODE
  }

  throw new RepositoryTriggerConfigError('Invalid sec_review_bot.trigger_mode value.', {
    reason: 'invalid-trigger-mode'
  })
}

function extractPathsIgnore (content: string): string[] {
  const config = parseRepositoryConfig(content)
  const value = config.paths_ignore

  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new RepositoryTriggerConfigError('Invalid sec_review_bot.paths_ignore value: expected an array.', {
      reason: 'invalid-paths-ignore'
    })
  }

  const patterns: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new RepositoryTriggerConfigError('Invalid sec_review_bot.paths_ignore item: expected string entries.', {
        reason: 'invalid-paths-ignore'
      })
    }

    const normalized = item.trim()
    if (!normalized) {
      throw new RepositoryTriggerConfigError('Invalid sec_review_bot.paths_ignore item: empty pattern is not allowed.', {
        reason: 'invalid-paths-ignore'
      })
    }
    patterns.push(normalized)
  }

  return patterns
}

export function isAutomaticTriggerModeEnabled (config: Partial<RepositoryTriggerConfig> | null | undefined): boolean {
  return (config?.trigger_mode ?? DEFAULT_TRIGGER_MODE) !== MANUAL_ONLY_TRIGGER_MODE
}

function isNotFoundError (error: unknown): boolean {
  return isRecord(error) && (error as GitHubLikeError).status === 404
}

interface FetchRepositoryTriggerConfigArgs {
  owner_login: string
  repo_name: string
  ref?: string
}

export async function fetchRepositoryTriggerConfig (
  octokit: GitHubAppOctokit,
  {
    owner_login,
    repo_name,
    ref
  }: FetchRepositoryTriggerConfigArgs
): Promise<RepositoryTriggerConfig> {
  const configRef = ref ?? null
  try {
    const request = {
      owner: owner_login,
      repo: repo_name,
      path: CONFIG_PATH,
      ...(ref ? { ref } : {})
    }
    const response = await octokit.rest.repos.getContent(request)

    const content = decodeRepositoryFileContent(response.data)
    if (typeof content !== 'string') {
      throw new RepositoryTriggerConfigError('Invalid trigger config file content.', {
        reason: 'invalid-content',
        owner_login,
        repo_name,
        ...(ref ? { ref } : {}),
        path: CONFIG_PATH
      })
    }

    try {
      return {
        trigger_mode: extractTriggerMode(content),
        paths_ignore: extractPathsIgnore(content),
        path: CONFIG_PATH,
        ref: configRef,
        source: 'repository-config'
      }
    } catch (error) {
      if (isRepositoryTriggerConfigError(error)) {
        error.owner_login = owner_login
        error.repo_name = repo_name
        error.ref = configRef
        error.path = CONFIG_PATH
      }
      throw error
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        trigger_mode: DEFAULT_TRIGGER_MODE,
        paths_ignore: [],
        path: null,
        ref: configRef,
        source: 'default'
      }
    }

    throw error
  }
}
