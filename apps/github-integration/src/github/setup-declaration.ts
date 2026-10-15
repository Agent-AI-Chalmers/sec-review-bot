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

/**
 * Reject `env` *keys* that resolve to a non-string.
 *
 * This is not a schema difference: it is that `toJS()` stringifies a non-string
 * mapping key (`true`/`123`/`null` -- whichever schema -- become `"true"`/`"123"`/
 * `"null"`), which would then pass the identifier check as a valid-looking name.
 * The runner's parser keeps the key's real type and rejects it, so this AST
 * check keeps the two enforcers on the same boundary. A quoted `"123"` stays a
 * string in both.
 */
function rejectNonStringEnvKeys(contents: Node | null): void {
  const steps = isMap(contents) ? contents.get('setup') : undefined
  if (!isSeq(steps)) {
    return
  }
  steps.items.forEach((step, index) => {
    if (!isMap(step)) {
      return
    }
    const env = step.get('env')
    if (!isMap(env)) {
      return
    }
    for (const item of (env as YAMLMap).items) {
      if (isScalar(item.key) && typeof item.key.value !== 'string') {
        throw new SetupDeclarationError(
          `setup[${index}].env must map string keys to string values.`,
          { reason: 'invalid-env' }
        )
      }
    }
  })
}

/**
 * Reject every explicit YAML tag (`!!bool`, `!!str`, `!!seq`, ...).
 *
 * The declaration format is the plain YAML 1.2 Core schema, and the two
 * enforcers disagree about explicit tags: `yaml` silently falls back to the raw
 * string when a tag's scalar does not match (`!!bool on` -> `"on"`), while the
 * runner's loader (yamlcore/PyYAML) raises. Rejecting every explicitly tagged
 * node here — the TS analogue of the runner's event-level check — keeps the two
 * classifications identical. A plain scalar carries no `tag` in the AST;
 * `!!str x`, `!!bool on`, and `!!seq [...]` all do.
 */
function rejectExplicitTags(node: Node | null): void {
  if (node === null || node === undefined) {
    return
  }
  if (typeof node.tag === 'string') {
    throw new SetupDeclarationError(
      `Setup declaration must not use explicit YAML tags (${node.tag}); the YAML 1.2 Core schema already resolves booleans, numbers, and null.`,
      { reason: 'explicit-tag' }
    )
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      rejectExplicitTags(pair.key as Node)
      rejectExplicitTags(pair.value as Node)
    }
    return
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      rejectExplicitTags(item as Node)
    }
  }
}

/**
 * Reject a `timeout_seconds` written in float syntax (e.g. `1.0`, `1e3`).
 *
 * `yaml` resolves `1.0`/`1e3` to a JS number whose `Number.isInteger` is true,
 * so `parseTimeout` would accept them; the runner's loader resolves them to a
 * Python `float`, which its `isinstance(value, int)` check rejects. Compare the
 * scalar's *source* text instead of the resolved value so both sides reject
 * float-syntax timeouts. Hex/octal integers (`0x10`, `0o10`) and signed
 * decimals stay valid, matching the runner.
 */
function rejectNonIntegerTimeoutScalars(contents: Node | null): void {
  const steps = isMap(contents) ? contents.get('setup') : undefined
  if (!isSeq(steps)) {
    return
  }
  steps.items.forEach((step, index) => {
    if (!isMap(step)) {
      return
    }
    const timeout = step.get('timeout_seconds', true)
    if (!isScalar(timeout) || typeof timeout.value !== 'number') {
      return
    }
    const source = typeof timeout.source === 'string' ? timeout.source : ''
    // Integer syntax only: no fraction/exponent marker.
    if (/[.eE]/.test(source)) {
      throw new SetupDeclarationError(`setup[${index}].timeout_seconds must be an integer.`, {
        reason: 'invalid-timeout'
      })
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

  // Parse with the YAML 1.2 Core schema, the same schema the runner uses (its
  // `yamlcore.CCoreLoader`). With one schema on both sides, every scalar
  // resolves identically, so no value-level reconciliation is needed: under the
  // Core schema `on`/`yes`/`no`/`off`/`y`/`n` are plain strings, not booleans.
  // Parse to a document, not plain JS, so `env` *keys* can still be inspected
  // before `toJS()` stringifies a non-string key.
  const document = parseDocument(content, { schema: 'core' })
  if (document.errors.length > 0) {
    throw new SetupDeclarationError('Setup declaration is not valid YAML.', {
      reason: 'invalid-yaml',
      cause: document.errors[0]
    })
  }
  rejectNonStringEnvKeys(document.contents)
  rejectExplicitTags(document.contents)
  rejectNonIntegerTimeoutScalars(document.contents)

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
