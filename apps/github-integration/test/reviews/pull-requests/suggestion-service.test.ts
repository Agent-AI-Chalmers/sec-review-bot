import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { generateSuggestionCandidatesFromReviewRecord } from '../../../src/reviews/pull-requests/suggestion-service.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'

function reviewRecordWithPatchDiff(patch_diff: string): ReviewRecord {
  return {
    analysis: {
      verdict: null,
      overview: null,
      narratives: []
    },
    mitigation: {
      overview: null,
      file_changes: [],
      patch_diff
    },
    verification: {
      overview: null,
      target_claim: null,
      validation_level: null,
      coverage: null,
      regression: null,
      next_step: null,
      findings: [],
      evidence: [],
      residual_risks: []
    },
    cvss: null
  }
}

function workspacePatchSample(): string {
  return [
    'diff --git a/src/server.js b/src/server.js',
    'index 726cbf4..92ccc97 100644',
    '--- a/src/server.js',
    '+++ b/src/server.js',
    "@@ -12,7 +12,7 @@ const DOWNLOAD_ROOT = path.resolve(process.cwd(), 'downloads')",
    " const PREVIEW_DEFAULT_FILE = 'README.md'",
    ' const PREVIEW_MAX_BYTES = 64 * 1024',
    ' const PREVIEW_MAX_LINES = 20',
    "-const DIAG_TOKEN = process.env.DIAG_TOKEN || 'internal-debug'",
    '+const DIAG_TOKEN = process.env.DIAG_TOKEN',
    '',
    ' function ensurePathInRoot (rootPath, candidatePath) {',
    '   const rootWithSep = rootPath.endsWith(path.sep)',
    "@@ -149,16 +149,12 @@ app.get('/preview-remote', (request, response) => {",
    " app.get('/admin/diag/run', (request, response) => {",
    "   const token = String(request.query.token || '')",
    "   const cmd = String(request.query.cmd || 'uptime')",
    "-  const bypassHeader = String(request.headers['x-internal-bypass'] || '').toLowerCase()",
    ' ',
    "   console.log('[diag] incoming request', {",
    '-    token,',
    '-    bypassHeader,',
    '-    cmd,',
    '     remote: request.ip',
    '   })',
    ' ',
    "-  if (token !== DIAG_TOKEN && bypassHeader !== '1') {",
    '+  if (token !== DIAG_TOKEN) {',
    '     response.status(403).json({',
    '       ok: false,',
    "       error: 'forbidden'"
  ].join('\n')
}

function workspacePatchWithInsertionSample(): string {
  return [
    'diff --git a/src/server.js b/src/server.js',
    'index 726cbf4..b98a4f4 100644',
    '--- a/src/server.js',
    '+++ b/src/server.js',
    "@@ -12,7 +12,7 @@ const DOWNLOAD_ROOT = path.resolve(process.cwd(), 'downloads')",
    " const PREVIEW_DEFAULT_FILE = 'README.md'",
    ' const PREVIEW_MAX_BYTES = 64 * 1024',
    ' const PREVIEW_MAX_LINES = 20',
    "-const DIAG_TOKEN = process.env.DIAG_TOKEN || 'internal-debug'",
    '+const DIAG_TOKEN = process.env.DIAG_TOKEN',
    ' ',
    ' function ensurePathInRoot (rootPath, candidatePath) {',
    '   const rootWithSep = rootPath.endsWith(path.sep)',
    "@@ -147,18 +147,23 @@ app.get('/preview-remote', (request, response) => {",
    ' })',
    ' ',
    " app.get('/admin/diag/run', (request, response) => {",
    '+  if (!DIAG_TOKEN) {',
    '+    response.status(500).json({',
    '+      ok: false,',
    "+      error: 'DIAG_TOKEN environment variable not configured'",
    '+    })',
    '+    return',
    '+  }',
    '+',
    "   const token = String(request.query.token || '')",
    "   const cmd = String(request.query.cmd || 'uptime')",
    "-  const bypassHeader = String(request.headers['x-internal-bypass'] || '').toLowerCase()",
    ' ',
    "   console.log('[diag] incoming request', {",
    '-    token,',
    '-    bypassHeader,',
    '     cmd,',
    '     remote: request.ip',
    '   })',
    ' ',
    "-  if (token !== DIAG_TOKEN && bypassHeader !== '1') {",
    '+  if (token !== DIAG_TOKEN) {',
    '     response.status(403).json({',
    '       ok: false,',
    "       error: 'forbidden'"
  ].join('\n')
}

test('suggestion candidates anchor to minimal changed line ranges instead of entire hunk ranges', async () => {
  const files = [
    {
      filename: 'src/server.js',
      patch: ['@@ -1,53 +1,53 @@', '@@ -89,87 +89,87 @@'].join('\n')
    }
  ]

  const manifest = await generateSuggestionCandidatesFromReviewRecord({
    files,
    review_record: reviewRecordWithPatchDiff(workspacePatchSample())
  })

  assert.strictEqual(manifest.candidates.length, 4)
  assert.deepStrictEqual(
    manifest.candidates.map((candidate) => ({
      start_line: candidate.start_line,
      line: candidate.line
    })),
    [
      { start_line: 15, line: 15 },
      { start_line: 152, line: 152 },
      { start_line: 155, line: 157 },
      { start_line: 161, line: 161 }
    ]
  )
  assert.match(manifest.candidates[0]?.body ?? '', /^```suggestion\n/)
  assert.doesNotMatch(
    manifest.candidates[0]?.body ?? '',
    /Mitigation candidate/
  )
})

test('suggestion candidates split a hunk into minimal contiguous +/- change blocks', async () => {
  const files = [
    {
      filename: 'src/server.js',
      patch: '@@ -1,260 +1,260 @@'
    }
  ]

  const manifest = await generateSuggestionCandidatesFromReviewRecord({
    files,
    review_record: reviewRecordWithPatchDiff(
      workspacePatchWithInsertionSample()
    )
  })

  assert.deepStrictEqual(
    manifest.candidates.map((candidate) => ({
      start_line: candidate.start_line,
      line: candidate.line
    })),
    [
      { start_line: 15, line: 15 },
      { start_line: 150, line: 150 },
      { start_line: 152, line: 152 },
      { start_line: 155, line: 156 },
      { start_line: 161, line: 161 }
    ]
  )
})

test('suggestion candidates accept repository-relative workspace patch paths', async () => {
  const manifest = await generateSuggestionCandidatesFromReviewRecord({
    files: [
      {
        filename: 'src/server.js',
        patch: ['@@ -1,53 +1,53 @@', '@@ -89,87 +89,87 @@'].join('\n')
      }
    ],
    review_record: reviewRecordWithPatchDiff(workspacePatchSample())
  })

  assert.strictEqual(manifest.skipped_reason, null)
  assert.strictEqual(manifest.candidates.length, 4)
})

for (const filename of [
  'workspace/src/app.ts',
  '中.txt',
  'a b.txt',
  'dir b/name.txt',
  'quote"name.txt',
  'tab\tname.txt',
  'back\\slash.txt',
  'emoji-😀.txt'
]) {
  test(`suggestions preserve actual Git filename ${JSON.stringify(filename)}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'suggestion-path-'))
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      git('init', '-q')
      mkdirSync(dirname(join(root, filename)), { recursive: true })
      writeFileSync(join(root, filename), 'old\n')
      git('add', '.')
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'base'
      )
      writeFileSync(join(root, filename), 'fixed\n')
      const patch = git(
        '-c',
        'core.quotePath=true',
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/'
      )
      const files = [filename, 'src/app.ts'].map((path) => ({
        filename: path,
        patch: '@@ -1 +1 @@\n-before\n+old'
      }))
      const manifest = await generateSuggestionCandidatesFromReviewRecord({
        files,
        review_record: reviewRecordWithPatchDiff(patch)
      })
      assert.deepStrictEqual(
        manifest.candidates.map((item) => item.path),
        [filename]
      )
      assert.strictEqual(manifest.candidates[0]?.replacement, 'fixed')
      assert.deepStrictEqual(manifest.unmapped_changes, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const destination of ['"b/bad\\q"', '"b/unterminated', '"b/\\377"']) {
  test(`unreadable Git path is reported: ${destination}`, async () => {
    const patch = [
      'diff --git a/file b/file',
      '--- a/file',
      `+++ ${destination}`,
      '@@ -1 +1 @@',
      '-old',
      '+fixed'
    ].join('\n')
    const manifest = await generateSuggestionCandidatesFromReviewRecord({
      files: [],
      review_record: reviewRecordWithPatchDiff(patch)
    })
    assert.deepStrictEqual(manifest.candidates, [])
    assert.strictEqual(manifest.unmapped_changes.length, 1)
    assert.ok(manifest.unmapped_changes[0]?.reason)
    assert.ok(manifest.skipped_reason)
  })
}
