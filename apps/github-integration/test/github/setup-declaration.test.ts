import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { SetupDeclarationError, parseSetupDeclaration } from '../../src/github/setup-declaration.js'
import { workspaceRoot } from '../contract-fixtures.js'

// Shared corpus of the setup-declaration contract family, also run by the
// runner's own test suite. Keeping both sides on the same files is what stops
// the integration validator and the runner parser from drifting apart. The
// corpus lives under its own family because the declaration format is decision
// logic enforced in code, not a JSON Schema-shaped contract.
const corpusDir = path.join(workspaceRoot(), 'contracts', 'setup-declaration', 'v1', 'corpus')

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
