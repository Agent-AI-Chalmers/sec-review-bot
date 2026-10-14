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

test('writes contract v6 manifest without trusted_setup by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'))
  try {
    await writeInputBundleManifest({
      input_bundle_root: root,
      include_incremental_window: false
    })
    const manifest = await readManifest(root)
    assert.equal(manifest.contract_version, 'v6')
    assert.equal(manifest.kind, 'runner-input-bundle')
    assert.equal('trusted_setup' in manifest, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('includes trusted_setup path when provided', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-trusted-'))
  try {
    await writeInputBundleManifest({
      input_bundle_root: root,
      include_incremental_window: false,
      trusted_setup_path: 'trusted-setup/setup.yml'
    })
    const manifest = await readManifest(root)
    assert.deepEqual(manifest.trusted_setup, { path: 'trusted-setup/setup.yml' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
