import { parse as parseYaml } from 'yaml'

import { isRecord } from '../utils/error-utils.js'

/**
 * Parse and validate the setup declaration (`.sec-review/setup.yml`).
 *
 * The GitHub integration is the producer of the runner workflow input, so it
 * owns the rules for what a declaration may contain. It reads the file from the
 * base repository's default branch and must decide, before submitting, whether
 * the content is a valid declaration. The runner parses the same text again as
 * defense in depth, but a malformed declaration is rejected *here*, with the
 * repository/ref/path context, rather than surfacing downstream as an opaque
 * contract violation.
 *
 * The allow-list below mirrors the runner's parser
 * (`agents/src/sec_review_agents/entrypoints/setup_declaration.py`). The two
 * must agree: a shared corpus is run by both sides' tests so they cannot
 * silently drift. (That corpus is the `setup-declaration` contract family; see
 * `contracts/setup-declaration/`.)
 *
 * Blank content is not an error: an empty or whitespace-only declaration means
 * "no declaration" and parses to `null`, matching the runner's notion of an
 * absent declaration.
 */

const ALLOWED_STEP_KEYS = new Set(['run', 'working-directory', 'env', 'timeout_seconds'])
const ALLOWED_TOP_LEVEL_KEYS = new Set(['setup'])

// Emitted as `export KEY=...`; restrict to portable shell identifiers so a
// declaration cannot smuggle shell syntax through a name.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface SetupDeclarationStep {
  run: string
  working_directory: string | null
  env: Record<string, string>
  timeout_seconds: number
}

export interface SetupDeclaration {
  steps: SetupDeclarationStep[]
}

export interface SetupDeclarationErrorOptions {
  owner_login?: string
  repo_name?: string
  ref?: string | null
  path?: string
  reason?: string
  cause?: unknown
}

export class SetupDeclarationError extends Error {
  owner_login: string | null
  repo_name: string | null
  ref: string | null
  path: string | null
  reason: string

  constructor(message: string, options: SetupDeclarationErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'SetupDeclarationError'
    this.owner_login = options.owner_login ?? null
    this.repo_name = options.repo_name ?? null
    this.ref = options.ref ?? null
    this.path = options.path ?? null
    this.reason = options.reason ?? 'unknown'
  }
}

export function isSetupDeclarationError(error: unknown): error is SetupDeclarationError {
  return (
    error instanceof SetupDeclarationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'SetupDeclarationError')
  )
}

function parseStep(raw: unknown, index: number): SetupDeclarationStep {
  const label = `setup[${index}]`
  if (!isRecord(raw)) {
    throw new SetupDeclarationError(`${label} must be a mapping.`, { reason: 'step-not-a-mapping' })
  }

  const unknownKeys = Object.keys(raw)
    .filter((key) => !ALLOWED_STEP_KEYS.has(key))
    .sort()
  if (unknownKeys.length > 0) {
    throw new SetupDeclarationError(`${label} has unsupported key(s): ${unknownKeys.join(', ')}`, {
      reason: 'unsupported-step-key'
    })
  }

  const run = raw['run']
  if (run === undefined || run === null) {
    throw new SetupDeclarationError(`${label} is missing the required 'run' key.`, {
      reason: 'missing-run'
    })
  }
  if (typeof run !== 'string' || run.trim() === '') {
    throw new SetupDeclarationError(`${label}.run must be a non-empty string.`, {
      reason: 'invalid-run'
    })
  }

  return {
    run,
    working_directory: parseWorkingDirectory(raw['working-directory'], label),
    env: parseEnv(raw['env'], label),
    timeout_seconds: parseTimeout(raw['timeout_seconds'], label)
  }
}

function parseWorkingDirectory(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SetupDeclarationError(`${label}.working-directory must be a non-empty string.`, {
      reason: 'invalid-working-directory'
    })
  }
  const normalized = value.trim()
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts[0] === '..') {
    throw new SetupDeclarationError(
      `${label}.working-directory must be relative to the repository root: ${JSON.stringify(value)}`,
      { reason: 'working-directory-escape' }
    )
  }
  if (parts.includes('..')) {
    throw new SetupDeclarationError(
      `${label}.working-directory must not escape the repository root: ${JSON.stringify(value)}`,
      { reason: 'working-directory-escape' }
    )
  }
  return normalized
}

function parseEnv(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isRecord(value)) {
    throw new SetupDeclarationError(`${label}.env must be a mapping of strings.`, {
      reason: 'invalid-env'
    })
  }
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new SetupDeclarationError(`${label}.env must map string keys to string values.`, {
        reason: 'invalid-env'
      })
    }
    if (!ENV_NAME_RE.test(key)) {
      throw new SetupDeclarationError(
        `${label}.env has an invalid variable name: ${JSON.stringify(key)}`,
        { reason: 'invalid-env-name' }
      )
    }
    env[key] = item
  }
  return env
}

function parseTimeout(value: unknown, label: string): number {
  if (value === undefined || value === null) {
    return 300
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SetupDeclarationError(`${label}.timeout_seconds must be an integer.`, {
      reason: 'invalid-timeout'
    })
  }
  if (value <= 0) {
    throw new SetupDeclarationError(`${label}.timeout_seconds must be positive.`, {
      reason: 'invalid-timeout'
    })
  }
  // The effective cap is enforced by the runner at execution time (it caps to
  // SEC_REVIEW_SETUP_STEP_MAX_SECONDS); the integration only validates shape.
  return value
}

/**
 * Validate a declaration's text. Returns `null` for blank content (no
 * declaration), otherwise the parsed steps. Throws `SetupDeclarationError` for
 * any content that is not a valid declaration.
 */
export function parseSetupDeclaration(content: string): SetupDeclaration | null {
  if (content.trim() === '') {
    return null
  }

  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch (error) {
    throw new SetupDeclarationError('Setup declaration is not valid YAML.', {
      reason: 'invalid-yaml',
      cause: error
    })
  }

  if (!isRecord(parsed)) {
    throw new SetupDeclarationError('Setup declaration must be a mapping at the top level.', {
      reason: 'not-a-mapping'
    })
  }

  const unknownTopLevel = Object.keys(parsed)
    .filter((key) => !ALLOWED_TOP_LEVEL_KEYS.has(key))
    .sort()
  if (unknownTopLevel.length > 0) {
    throw new SetupDeclarationError(
      `Setup declaration has unsupported top-level key(s): ${unknownTopLevel.join(', ')}`,
      { reason: 'unsupported-top-level-key' }
    )
  }

  const rawSteps = parsed['setup']
  if (rawSteps === undefined || rawSteps === null) {
    throw new SetupDeclarationError("Setup declaration is missing the required 'setup' key.", {
      reason: 'missing-setup-key'
    })
  }
  if (!Array.isArray(rawSteps)) {
    throw new SetupDeclarationError("Setup declaration 'setup' must be a list of steps.", {
      reason: 'setup-not-a-list'
    })
  }

  return { steps: rawSteps.map((rawStep, index) => parseStep(rawStep, index)) }
}
