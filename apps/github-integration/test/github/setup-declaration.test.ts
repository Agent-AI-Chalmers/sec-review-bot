import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  SetupDeclarationError,
  parseSetupDeclaration
} from '../../src/github/setup-declaration.js'
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
  return JSON.parse(
    readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8')
  ) as CorpusManifest
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
  assert.deepStrictEqual(
    [...manifest.valid, ...manifest.invalid].sort(),
    files,
    'manifest must classify every corpus file and nothing else'
  )
  assert.strictEqual(
    manifest.valid.some((name) => manifest.invalid.includes(name)),
    false,
    'a case cannot be both valid and invalid'
  )
})

test('shared setup-declaration corpus classifies consistently', () => {
  const manifest = corpusManifest()
  for (const name of manifest.valid) {
    const content = readFileSync(path.join(corpusDir, name), 'utf8')
    assert.notStrictEqual(
      parseSetupDeclaration(content),
      null,
      `${name} should parse to a declaration`
    )
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
  assert.strictEqual(parseSetupDeclaration(''), null)
  assert.strictEqual(parseSetupDeclaration('   \n\n'), null)
})

test('rejects an invalid declaration with a reason', () => {
  assert.throws(
    () => parseSetupDeclaration('setup:\n  - uses: actions/checkout@v4\n'),
    (error: unknown) =>
      error instanceof SetupDeclarationError &&
      error.reason === 'unsupported-step-key'
  )
})

test('accepts YAML 1.1 boolean words as plain strings under the Core schema', () => {
  // Both enforcers parse with the YAML 1.2 Core schema, where `on`/`yes`/`off`/
  // `no`/`y`/`n` are ordinary strings. They are therefore valid commands, paths,
  // env values, and env keys -- not the booleans a YAML 1.1 parser would see.
  for (const word of ['on', 'yes', 'off', 'no', 'y', 'n', 'Y', 'N']) {
    const declaration = parseSetupDeclaration(
      `setup:\n  - run: ${word}\n    working-directory: ${word}\n    env:\n      ${word}: ${word}\n`
    )
    assert.strictEqual(declaration?.steps[0]?.run, word)
    assert.strictEqual(declaration?.steps[0]?.working_directory, word)
    assert.strictEqual(declaration?.steps[0]?.env[word], word)
  }
})

test('rejects unquoted booleans and numbers in string positions', () => {
  // The words above are strings, but real booleans/numbers are not strings in
  // either dialect, so a string-valued position still rejects them.
  for (const raw of ['true', 'false', '123']) {
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: ${raw}\n`),
      SetupDeclarationError,
      `run: ${raw} should be rejected`
    )
    assert.throws(
      () =>
        parseSetupDeclaration(
          `setup:\n  - run: x\n    working-directory: ${raw}\n`
        ),
      SetupDeclarationError,
      `working-directory: ${raw} should be rejected`
    )
    assert.throws(
      () =>
        parseSetupDeclaration(
          `setup:\n  - run: x\n    env:\n      FLAG: ${raw}\n`
        ),
      SetupDeclarationError,
      `env value ${raw} should be rejected`
    )
  }
})

test('rejects non-string env keys', () => {
  for (const raw of ['true', '123', '1.5', 'null', '~']) {
    assert.throws(
      () =>
        parseSetupDeclaration(
          `setup:\n  - run: x\n    env:\n      ${raw}: ok\n`
        ),
      SetupDeclarationError,
      `env key ${raw} should be rejected`
    )
  }
})

test('rejects explicit YAML tags', () => {
  // The format is the plain Core schema. Both enforcers reject every explicit
  // tag, because `yaml` silently falls back to the raw string for a mismatched
  // tag (`!!bool on` -> "on") while the runner's loader raises.
  for (const raw of [
    '!!bool on',
    '!!str npm ci',
    '!!seq [a]',
    '!!set {a}',
    '!!int 5'
  ]) {
    assert.throws(
      () => parseSetupDeclaration(`setup:\n  - run: ${raw}\n`),
      SetupDeclarationError,
      `explicit tag ${raw} should be rejected`
    )
  }
})

test('rejects a float-syntax timeout', () => {
  // `1.0`/`1e3` resolve to an integer-valued JS number, but the runner resolves
  // them to a Python float and rejects them; both sides reject by source text.
  for (const raw of ['1.0', '1e3', '1.0e2', '10.']) {
    assert.throws(
      () =>
        parseSetupDeclaration(
          `setup:\n  - run: x\n    timeout_seconds: ${raw}\n`
        ),
      SetupDeclarationError,
      `timeout ${raw} should be rejected`
    )
  }
  for (const raw of ['100', '0x10', '0o10', '+5']) {
    assert.doesNotThrow(
      () =>
        parseSetupDeclaration(
          `setup:\n  - run: x\n    timeout_seconds: ${raw}\n`
        ),
      `timeout ${raw} should be accepted`
    )
  }
})

test('rejects an oversized declaration', () => {
  const filler = 'x'.repeat(65536 + 1)
  assert.throws(
    () => parseSetupDeclaration(`setup:\n  - run: ${filler}\n`),
    SetupDeclarationError
  )
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
    (error: unknown) =>
      error instanceof SetupDeclarationError && error.reason === 'invalid-yaml'
  )
})
