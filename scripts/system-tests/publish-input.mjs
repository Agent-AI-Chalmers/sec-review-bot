// Publish with production TypeScript code; Python consumes the resulting reference.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { writeInputBundleManifest } from '../../apps/github-integration/dist/execution/input-bundle-manifest.js'
import { archiveInputBundle } from '../../apps/github-integration/dist/reviews/shared/input-bundle.js'
import { publishInputBundle } from '../../apps/github-integration/dist/artifacts/input-storage.js'

const [root, runId, output] = process.argv.slice(2)
await mkdir(path.join(root, 'workspace'), { recursive: true })
await mkdir(path.join(root, 'history'), { recursive: true })
await writeFile(path.join(root, 'workspace', 'probe.txt'), '跨语言 bundle\n')
await writeFile(path.join(root, 'history', 'issue.json'), '{"number":1}')
await promisify(execFile)('tar', [
  '-cf',
  path.join(root, 'workspace.snapshot.tar'),
  '-C',
  path.join(root, 'workspace'),
  'probe.txt',
])
await writeInputBundleManifest({
  input_bundle_root: root,
  include_incremental_window: false,
})
const local = await archiveInputBundle({
  input_bundle_root: root,
  include_incremental_window: false,
})
const reference = await publishInputBundle(local, runId)
assert.deepEqual(await publishInputBundle(local, runId), reference)
await writeFile(output, JSON.stringify(reference))
