import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { writeInputBundleManifest } from '../../src/runner/input-bundle-manifest.js'

async function readManifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(root, 'manifest.json'), 'utf8')
  ) as Record<string, unknown>
}

test('writes the contract v6 manifest without a setup declaration field', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'))
  try {
    await writeInputBundleManifest({
      input_bundle_root: root,
      include_incremental_window: false
    })
    const manifest = await readManifest(root)
    assert.equal(manifest.contract_version, 'v6')
    assert.equal(manifest.kind, 'runner-input-bundle')
    // The setup declaration travels inline in the workflow input, not the manifest.
    assert.equal('setup_declaration' in manifest, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
