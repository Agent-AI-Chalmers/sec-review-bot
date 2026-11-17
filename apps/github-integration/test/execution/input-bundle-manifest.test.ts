import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { writeInputBundleManifest } from '../../src/execution/input-bundle-manifest.js'

async function readManifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(root, 'manifest.json'), 'utf8')
  ) as Record<string, unknown>
}

test('writes the API v1 manifest without a setup declaration field', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'))
  try {
    await writeInputBundleManifest({
      input_bundle_root: root,
      include_incremental_window: false
    })
    const manifest = await readManifest(root)
    expect(manifest.api_version).toBe('v1')
    expect('kind' in manifest).toBe(false)
    // The setup declaration travels inline in the workflow input, not the manifest.
    expect('setup_declaration' in manifest).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
