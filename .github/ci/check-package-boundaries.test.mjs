import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    assert.equal(check('', { devDependencies: { '@test/api': version } }).length, 1)
  }
  assert.equal(check('', { dependencies: { alias: 'file:../../services/api' } }).length, 1)
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
    'import(`@test/api`)',
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
  assert.equal(checkBoundaries(Object.keys(files), (file) => files[file]).length, 1)
  files['services/review-runs/test/integration/cross-package.test.ts'] =
    "require('../../../../apps/github-integration/src/app.ts')"
  assert.equal(checkBoundaries(Object.keys(files), (file) => files[file]).length, 1)
})

test('rejects malformed source rather than silently losing references', () => {
  const errors = check("import { from '@test/api'")
  assert.equal(errors.length, 1)
  assert.match(errors[0], /invalid source/)
})

test('tsconfig aliases cannot bypass package ownership', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const app = mkdtempSync(path.join(root, 'apps/boundary-probe-'))
  const service = mkdtempSync(path.join(root, 'services/boundary-probe-'))
  try {
    mkdirSync(path.join(app, 'src'))
    writeFileSync(path.join(app, 'package.json'), '{"name":"@probe/ui"}')
    writeFileSync(path.join(service, 'package.json'), '{"name":"@probe/api"}')
    writeFileSync(path.join(service, 'server.ts'), 'export const server = 1')
    writeFileSync(
      path.join(app, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { '@api/*': [`${path.relative(app, service)}/*`] } }
      })
    )
    writeFileSync(path.join(app, 'src/main.ts'), "import { server } from '@api/server'")
    const files = [
      path.join(app, 'package.json'),
      path.join(service, 'package.json'),
      path.join(app, 'src/main.ts')
    ].map((file) => path.relative(root, file).split(path.sep).join('/'))
    assert.equal(checkBoundaries(files).length, 1)
  } finally {
    rmSync(app, { recursive: true, force: true })
    rmSync(service, { recursive: true, force: true })
  }
})
