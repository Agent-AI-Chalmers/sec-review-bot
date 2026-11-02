import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  parsePatch,
  parseUnifiedDiff
} from '../browser/features/trajectory/diff-parse.js'

function fixture(name: string): string {
  return readFileSync(
    new URL('./fixtures/diffs/' + name, import.meta.url),
    'utf8'
  )
}

function rowsOf(text: string): Array<[string, string]> {
  const files = parseUnifiedDiff(text)
  assert.equal(files.length, 1)
  return files[0]!.hunks.flatMap((hunk) =>
    hunk.rows.map((row) => [row.kind, row.text] as [string, string])
  )
}

test('unified diff keeps changes whose content starts with -- or ++', () => {
  // The markers "---"/"+++" also appear inside a hunk for "-- old"/"++ new".
  // The @@ line counts are what distinguish them from file headers.
  const rows = rowsOf(
    [
      'Index: /workspace/src/sample.txt',
      '--- a/src/sample.txt',
      '+++ b/src/sample.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '--- old',
      '+++ new'
    ].join('\n')
  )
  assert.deepEqual(rows, [
    ['context', 'keep'],
    ['remove', '-- old'],
    ['add', '++ new']
  ])
})

test('a deleted file keeps the old path and is marked deleted', () => {
  const files = parseUnifiedDiff(
    [
      'Index: /workspace/keep.txt',
      '--- /workspace/keep.txt',
      '+++ /workspace/keep.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'Index: /workspace/gone.txt',
      '--- /workspace/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two'
    ].join('\n')
  )
  assert.deepEqual(
    files.map((file) => [file.path, file.status]),
    [
      ['/workspace/keep.txt', undefined],
      ['/workspace/gone.txt', 'deleted']
    ]
  )
  assert.deepEqual(
    files[1]!.hunks[0]!.rows.map((row) => row.kind),
    ['remove', 'remove']
  )
})

test('a new file with /dev/null on the old side is marked added', () => {
  const files = parseUnifiedDiff(
    [
      'Index: /workspace/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello'
    ].join('\n')
  )
  assert.equal(files.length, 1)
  assert.equal(files[0]!.status, 'added')
  assert.deepEqual(files[0]!.hunks[0]!.rows, [{ kind: 'add', text: 'hello' }])
})

test('Begin Patch move and delete keep the operation metadata', () => {
  const files = parseUnifiedDiff(
    [
      '*** Begin Patch',
      '*** Update File: /workspace/old.py',
      '*** Move to: /workspace/new.py',
      '@@',
      '-x = 1',
      '+x = 2',
      '*** Delete File: /workspace/gone.py',
      '*** End Patch'
    ].join('\n')
  )
  assert.equal(files.length, 2)
  assert.equal(files[0]!.path, '/workspace/new.py')
  assert.equal(files[0]!.movedFrom, '/workspace/old.py')
  assert.deepEqual(files[0]!.hunks[0]!.rows, [
    { kind: 'remove', text: 'x = 1' },
    { kind: 'add', text: 'x = 2' }
  ])
  assert.equal(files[1]!.path, '/workspace/gone.py')
  assert.equal(files[1]!.status, 'deleted')
  assert.equal(files[1]!.hunks[0]!.rows.length, 0)
})

test('Begin Patch update content without @@ is rejected, not dropped', () => {
  // OpenCode's apply_patch requires each update chunk to start with "@@";
  // a patch that omits it is damaged and must not silently lose a file.
  const files = parseUnifiedDiff(
    [
      '*** Begin Patch',
      '*** Update File: /workspace/a.txt',
      '-old',
      '+new',
      '*** Add File: /workspace/b.txt',
      '+hello',
      '*** End Patch'
    ].join('\n')
  )
  assert.deepEqual(files, [])
})

test('operation-only files survive the empty-hunk filter', () => {
  const files = parseUnifiedDiff(
    [
      '*** Begin Patch',
      '*** Delete File: /workspace/gone.py',
      '*** End Patch'
    ].join('\n')
  )
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, '/workspace/gone.py')
  assert.equal(files[0]!.status, 'deleted')
})

test('a hunk whose counts end early is rejected', () => {
  const files = parseUnifiedDiff(
    [
      'Index: /workspace/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      ' keep',
      '+leftover'
    ].join('\n')
  )
  assert.deepEqual(files, [])
})

test('a hunk that runs out of input is rejected', () => {
  const files = parseUnifiedDiff(
    [
      'Index: /workspace/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,4 +1,4 @@',
      ' keep'
    ].join('\n')
  )
  assert.deepEqual(files, [])
})

test('a header before the counts run out is rejected', () => {
  const files = parseUnifiedDiff(
    [
      'Index: /workspace/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,5 +1,5 @@',
      ' keep',
      'Index: /workspace/b.txt'
    ].join('\n')
  )
  assert.deepEqual(files, [])
})

test('a bare @@ in a unified diff is rejected', () => {
  const files = parseUnifiedDiff(
    [
      'Index: /workspace/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@',
      '-old',
      '+new'
    ].join('\n')
  )
  assert.deepEqual(files, [])
})

test('plain text without hunks is not treated as a diff', () => {
  assert.deepEqual(parseUnifiedDiff('just a log line\nand another'), [])
})

test('a real OpenCode edit diff parses into one file', () => {
  const files = parseUnifiedDiff(fixture('opencode-edit.diff'))
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, '/workspace/shescape/src/win.js')
  assert.equal(files[0]!.hunks.length, 1)
  const rows = files[0]!.hunks[0]!.rows
  assert.ok(
    rows.some(
      (row) => row.kind === 'remove' && row.text.includes('arg.replace(/"/g')
    )
  )
  assert.ok(
    rows.some((row) => row.kind === 'add' && row.text.includes('match ==='))
  )
})

test('a real OpenCode apply_patch diff keeps both files', () => {
  const files = parseUnifiedDiff(fixture('opencode-apply-patch.diff'))
  assert.deepEqual(
    files.map((file) => file.path),
    [
      '/workspace/shescape/src/main.js',
      '/workspace/shescape/test/index.test.js'
    ]
  )
  assert.ok(files.every((file) => file.hunks.length === 1))
})

test('a real Begin Patch keeps both updates', () => {
  const files = parseUnifiedDiff(fixture('begin-patch.txt'))
  assert.deepEqual(
    files.map((file) => file.path),
    [
      '/workspace/shescape/src/main.js',
      '/workspace/shescape/test/index.test.js'
    ]
  )
  assert.ok(files.every((file) => file.hunks.length === 1))
})

test('CRLF input is normalized before parsing', () => {
  const lf = fixture('opencode-edit.diff')
  assert.deepEqual(
    parseUnifiedDiff(lf.replace(/\n/g, '\r\n')),
    parseUnifiedDiff(lf)
  )
})

test('a hunk before the matching +++ is rejected', () => {
  // The second file has only its "---" header; its hunk must not be attached
  // to the first file just because a file is still open.
  const parsed = parsePatch(
    [
      'Index: /workspace/a.txt',
      '--- /workspace/a.txt',
      '+++ /workspace/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- /workspace/second.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y'
    ].join('\n')
  )
  assert.equal(parsed.invalid, true)
  assert.deepEqual(parsed.files, [])
})

test('an unpaired --- header at end of input is rejected', () => {
  const parsed = parsePatch(
    ['Index: /workspace/a.txt', '--- /workspace/a.txt'].join('\n')
  )
  assert.equal(parsed.invalid, true)
  assert.deepEqual(parsed.files, [])
})

test('parsePatch reports damaged input instead of partial files', () => {
  const parsed = parsePatch(
    [
      'Index: /workspace/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,4 +1,4 @@',
      ' keep'
    ].join('\n')
  )
  assert.equal(parsed.invalid, true)
  assert.deepEqual(parsed.files, [])
})
