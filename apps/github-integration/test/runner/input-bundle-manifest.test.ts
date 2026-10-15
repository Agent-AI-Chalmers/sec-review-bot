import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { writeInputBundleManifest } from '../../src/runner/input-bundle-manifest.js'

async function readManifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

test('writes contract v6 manifest without setup_declaration by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'))
  try {
    await writeInputBundleManifest({
      input_bundle_root: root,
      include_incremental_window: false
    })
    const manifest = await readManifest(root)
    assert.equal(manifest.contract_version, 'v6')
    assert.equal(manifest.kind, 'runner-input-bundle')
    assert.equal('setup_declaration' in manifest, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('includes setup_declaration path when provided', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-setup-'))
  try {
    await writeInputBundleManifest({
      input_bundle_root: root,
      include_incremental_window: false,
      setup_declaration_path: 'setup/setup.yml'
    })
    const manifest = await readManifest(root)
    assert.deepEqual(manifest.setup_declaration, { path: 'setup/setup.yml' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
