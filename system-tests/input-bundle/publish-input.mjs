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
// Later stages restore this snapshot and resolve its baseline commit.
const workspace = path.join(root, 'workspace')
await promisify(execFile)('git', ['init', '--initial-branch=main', workspace])
await promisify(execFile)('git', ['-C', workspace, 'add', 'probe.txt'])
await promisify(execFile)('git', [
  '-C',
  workspace,
  '-c',
  'user.name=System Test',
  '-c',
  'user.email=system-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  'commit',
  '-m',
  'Initial fixture'
])
await promisify(execFile)('tar', [
  '-cf',
  path.join(root, 'workspace.snapshot.tar'),
  '-C',
  root,
  'workspace'
])
await writeInputBundleManifest({
  input_bundle_root: root,
  include_incremental_window: false
})
const local = await archiveInputBundle({
  input_bundle_root: root,
  include_incremental_window: false
})
const reference = await publishInputBundle(local, runId)
assert.deepEqual(await publishInputBundle(local, runId), reference)
await writeFile(output, JSON.stringify(reference))
