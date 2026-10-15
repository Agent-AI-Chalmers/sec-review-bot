import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { SetupDeclarationError, parseSetupDeclaration } from '../../src/github/setup-declaration.js'
import { CONTRACTS_ROOT } from '../contract-fixtures.js'

// Shared corpus of the setup-declaration contract family, also run by the
// runner's own test suite. Keeping both sides on the same files is what stops
// the integration validator and the runner parser from drifting apart. The
// corpus lives under its own family because the declaration format is decision
// logic enforced in code, not a JSON Schema-shaped contract.
const corpusDir = path.join(CONTRACTS_ROOT, 'setup-declaration', 'v1', 'corpus')

interface CorpusManifest {
  valid: string[]
  invalid: string[]
}

function corpusManifest(): CorpusManifest {
  return JSON.parse(readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8')) as CorpusManifest
}

function corpusFiles(): string[] {
  return readdirSync(corpusDir)
    .filter((name) => name.endsWith('.yml'))
    .sort()
}

test('every corpus file is classified by the manifest', () => {
  const manifest = corpusManifest()
  const files = corpusFiles()
  assert.ok(files.length > 0, 'expected shared setup-declaration corpus')
  assert.deepEqual(
    [...manifest.valid, ...manifest.invalid].sort(),
    files,
    'manifest must classify every corpus file and nothing else'
  )
  assert.equal(
    manifest.valid.some((name) => manifest.invalid.includes(name)),
    false,
    'a case cannot be both valid and invalid'
  )
})

test('shared setup-declaration corpus classifies consistently', () => {
  const manifest = corpusManifest()
  for (const name of manifest.valid) {
    const content = readFileSync(path.join(corpusDir, name), 'utf8')
    assert.notEqual(parseSetupDeclaration(content), null, `${name} should parse to a declaration`)
  }
  for (const name of manifest.invalid) {
    const content = readFileSync(path.join(corpusDir, name), 'utf8')
    assert.throws(
      () => parseSetupDeclaration(content),
      SetupDeclarationError,
      `${name} should be rejected`
    )
  }
})

test('blank content means no declaration', () => {
  assert.equal(parseSetupDeclaration(''), null)
  assert.equal(parseSetupDeclaration('   \n\n'), null)
})

test('rejects an invalid declaration with a reason', () => {
  assert.throws(
    () => parseSetupDeclaration('setup:\n  - uses: actions/checkout@v4\n'),
    (error: unknown) =>
      error instanceof SetupDeclarationError && error.reason === 'unsupported-step-key'
  )
})

test('rejects unquoted boolean-like run and working-directory values', () => {
  // Although this validator parses with the `yaml` library (YAML 1.2), where
  // `on`/`yes`/`off`/`no` are plain strings, the runner parses with PyYAML
  // (YAML 1.1), where they are booleans. Every string-valued position is held
  // to that stricter reading here, so the integration cannot accept a
  // declaration the runner then refuses to execute.
  for (const raw of ['on', 'yes', 'off', 'no']) {
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: ${raw}\n`),
      SetupDeclarationError,
      `run: ${raw} should be rejected`
    )
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: x\n    working-directory: ${raw}\n`),
      SetupDeclarationError,
      `working-directory: ${raw} should be rejected`
    )
  }
})

test('rejects unquoted boolean-like env values', () => {
  for (const raw of ['on', 'yes', 'off', 'no']) {
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: x\n    env:\n      FLAG: ${raw}\n`),
      SetupDeclarationError,
      `env value ${raw} should be rejected`
    )
  }
})

test('rejects plain boolean-like env keys (matches the runner dialect)', () => {
  // `env` *keys* are kept on the runner's YAML 1.1 reading even though this
  // validator uses YAML 1.2: an unquoted `on`/`yes`/... would be a boolean for
  // PyYAML but a string here, so it is rejected here too rather than letting a
  // declaration through that the runner would then refuse to execute.
  for (const raw of ['on', 'yes', 'off', 'no', 'true', 'false']) {
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: x\n    env:\n      ${raw}: ok\n`),
      SetupDeclarationError,
      `env key ${raw} should be rejected`
    )
  }
})

test('accepts a quoted boolean-like env key in both dialects', () => {
  const declaration = parseSetupDeclaration('setup:\n  - run: x\n    env:\n      "on": ok\n')
  assert.equal(declaration?.steps[0]?.env['on'], 'ok')
})

test('rejects non-string env keys', () => {
  for (const raw of ['true', '123', '1.5', 'null', '~']) {
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: x\n    env:\n      ${raw}: ok\n`),
      SetupDeclarationError,
      `env key ${raw} should be rejected`
    )
  }
})

test('rejects an oversized declaration', () => {
  const filler = 'x'.repeat(65536 + 1)
  assert.throws(() => parseSetupDeclaration(`setup:\n  - run: ${filler}\n`), SetupDeclarationError)
})

test('rejects an alias-expansion bomb as an invalid declaration', () => {
  let bomb = 'a: &a ["x","x","x","x","x","x","x","x","x","x"]\n'
  for (let i = 0; i < 9; i += 1) {
    const prev = String.fromCharCode(97 + i)
    const next = String.fromCharCode(98 + i)
    const refs = Array.from({ length: 9 }, () => `*${prev}`).join(',')
    bomb += `${next}: &${next} [${refs}]\n`
  }
  assert.throws(
    () => parseSetupDeclaration(`setup:\n  - run: x\n${bomb}`),
    (error: unknown) => error instanceof SetupDeclarationError && error.reason === 'invalid-yaml'
  )
})
