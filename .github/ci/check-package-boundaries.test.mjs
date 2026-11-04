import assert from 'node:assert/strict'
import test from 'node:test'
import { checkBoundaries } from './check-package-boundaries.mjs'

function check(source, dependency = {}) {
  const files = {
    'apps/ui/package.json': JSON.stringify({ name: '@test/ui', ...dependency }),
    'services/api/package.json': JSON.stringify({ name: '@test/api' }),
    'contracts/codegen/package.json': JSON.stringify({ name: '@test/codegen' }),
    'contracts/api/tools/package.json': JSON.stringify({
      name: '@test/tools',
      devDependencies: { '@test/codegen': 'workspace:*' }
    }),
    'apps/ui/src/main.ts': source,
    'contracts/api/tools/main.ts': "export { generate } from '@test/codegen'"
  }
  return checkBoundaries(Object.keys(files), (file) => files[file])
}

test('allows package-local imports and contract tools using codegen', () => {
  assert.deepEqual(check("import './local.js'"), [])
})

test('rejects dependencies on another application or service regardless of version protocol', () => {
  for (const version of ['workspace:*', '*', '1.0.0']) {
    assert.equal(
      check('', { devDependencies: { '@test/api': version } }).length,
      1
    )
  }
  assert.equal(
    check('', { dependencies: { alias: 'file:../../services/api' } }).length,
    1
  )
})

test('rejects static, type-only, re-export, dynamic, require and URL references across packages', () => {
  for (const source of [
    "import { server } from '@test/api'",
    "import type { Server } from '../../../services/api/src/server.js'",
    "export * from '@test/api/internal'",
    "import('../../../services/api/src/server.js')",
    "require('../../../services/api/src/server.ts')",
    "new URL('../../../services/api/src/server.js', import.meta.url)",
    "type Server = import('@test/api').Server",
    "import '@test/codegen'"
  ]) {
    assert.equal(check(source).length, 1, source)
  }
})

test('rejects cross-package references in tests as well as production code', () => {
  const files = {
    'services/review-runs/package.json': '{"name":"@test/runs"}',
    'apps/github-integration/package.json': '{"name":"@test/integration"}',
    'services/review-runs/test/integration/cross-package.test.ts':
      "require('../../../../apps/github-integration/src/review-runs/client.ts')"
  }
  assert.equal(
    checkBoundaries(Object.keys(files), (file) => files[file]).length,
    1
  )
  files['services/review-runs/test/integration/cross-package.test.ts'] =
    "require('../../../../apps/github-integration/src/app.ts')"
  assert.equal(
    checkBoundaries(Object.keys(files), (file) => files[file]).length,
    1
  )
})
