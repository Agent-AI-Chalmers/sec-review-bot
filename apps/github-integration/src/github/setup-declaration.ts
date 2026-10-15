import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Node, YAMLMap } from 'yaml'

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

// Upper bound on the declaration text. It travels inline in the workflow input,
// so an unbounded default-branch file would grow every submission; the runner's
// parser and the contract schema carry the same limit.
export const MAX_SETUP_DECLARATION_BYTES = 65536

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

// YAML 1.1 boolean words that the `yaml` library (YAML 1.2) reads as plain
// strings. The runner's PyYAML (1.1) reads them as booleans, so an *unquoted*
// `run: on` (or `working-directory: no`, or an `env` key/value `yes`) is a
// boolean for the runner but a string here — enough to let the integration
// accept a declaration the runner then refuses to execute. `true`/`false` are
// absent on purpose: both dialects already resolve them to booleans, so the
// value-level type checks reject them. The two libraries also disagree on
// single-letter `y`/`n` (1.1 spec says boolean, PyYAML says string); they are
// deliberately not treated as boolean-like here, matching PyYAML.
const YAML_1_1_BOOLEAN_WORDS = new Set(['yes', 'no', 'on', 'off'])

/** A plain (unquoted) scalar that this validator reads as a string but the
 * runner reads as a boolean. A quoted `"on"` is a string in both dialects. */
function isYaml11BooleanWord(node: unknown): boolean {
  return (
    isScalar(node) &&
    node.type === 'PLAIN' &&
    typeof node.value === 'string' &&
    YAML_1_1_BOOLEAN_WORDS.has(node.value.toLowerCase())
  )
}

/**
 * Reject the scalars where the two YAML dialects disagree, so the integration
 * cannot accept a declaration the runner then refuses to execute.
 *
 * Two checks, both on the AST (the resolved JS value has already lost quoting):
 *
 * - an `env` key that resolves to a non-string (a plain `true`/`123`/`null`) —
 *   PyYAML rejects it, and `toJS()` would stringify it into a valid-looking key;
 * - an unquoted boolean-like scalar in any string position — `run`,
 *   `working-directory`, an `env` key, or an `env` value.
 */
function rejectNonPortableScalars(contents: Node | null): void {
  const steps = isMap(contents) ? contents.get('setup') : undefined
  if (!isSeq(steps)) {
    return
  }
  steps.items.forEach((step, index) => {
    if (!isMap(step)) {
      return
    }
    for (const item of (step as YAMLMap).items) {
      const key = isScalar(item.key) ? item.key.value : undefined
      if (key === 'run' || key === 'working-directory') {
        if (isYaml11BooleanWord(item.value)) {
          throw new SetupDeclarationError(
            `setup[${index}].${key} is a boolean-like scalar that must be quoted: ${JSON.stringify(
              (item.value as { value: string }).value
            )}`,
            { reason: key === 'run' ? 'invalid-run' : 'invalid-working-directory' }
          )
        }
      } else if (key === 'env' && isMap(item.value)) {
        for (const pair of (item.value as YAMLMap).items) {
          if (isScalar(pair.key) && typeof pair.key.value !== 'string') {
            throw new SetupDeclarationError(
              `setup[${index}].env must map string keys to string values.`,
              { reason: 'invalid-env' }
            )
          }
          if (isYaml11BooleanWord(pair.key)) {
            throw new SetupDeclarationError(
              `setup[${index}].env has a boolean-like key that must be quoted: ${JSON.stringify(
                (pair.key as { value: string }).value
              )}`,
              { reason: 'invalid-env-name' }
            )
          }
          if (isYaml11BooleanWord(pair.value)) {
            throw new SetupDeclarationError(
              `setup[${index}].env has a boolean-like value that must be quoted: ${JSON.stringify(
                (pair.value as { value: string }).value
              )}`,
              { reason: 'invalid-env' }
            )
          }
        }
      }
    }
  })
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
  if (Buffer.byteLength(content, 'utf8') > MAX_SETUP_DECLARATION_BYTES) {
    throw new SetupDeclarationError(
      `Setup declaration exceeds ${MAX_SETUP_DECLARATION_BYTES} bytes.`,
      { reason: 'declaration-too-large' }
    )
  }

  // Parse to a document (not plain JS) so `env` *keys* can be inspected with
  // their scalar type and quoting preserved. The `yaml` library reads an
  // unquoted `on` as the string `"on"` (YAML 1.2) while the runner's PyYAML
  // reads it as a boolean (YAML 1.1); a plain key-level pre-pass keeps both
  // enforcers on the same boundary for keys, without disturbing the value-level
  // dialect divergence the SPEC documents for `run`.
  const document = parseDocument(content)
  if (document.errors.length > 0) {
    throw new SetupDeclarationError('Setup declaration is not valid YAML.', {
      reason: 'invalid-yaml',
      cause: document.errors[0]
    })
  }
  rejectNonPortableScalars(document.contents)

  let parsed: unknown
  try {
    // Resolving aliases/anchors happens here, not in parseDocument; bound it
    // against alias-expansion bombs and surface any failure as a declaration
    // error rather than a raw library exception.
    parsed = document.toJS({ maxAliasCount: 100 })
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
