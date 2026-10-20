import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReviewWindowFiles } from '../../../src/reviews/pull-requests/review-window.js'
import type { PullRequestFile } from '../../../src/github/pull-request-service.js'

function file(filename: string): PullRequestFile {
  return {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@'
  } as PullRequestFile
}

test('a non-synchronize event always uses the full pull request window', async () => {
  const calls: string[] = []
  const result = await resolveReviewWindowFiles({
    event_type: 'opened',
    pr: { base_sha: 'base', head_sha: 'head', previous_head_sha: 'deadbeef' },
    list_push_window_files: async () => {
      calls.push('push')
      return { files: [file('pushed.ts')], previous_head_is_ancestor: true }
    },
    list_full_window_files: async () => {
      calls.push('full')
      return [file('whole-pr.ts')]
    }
  })

  // A previous head on a non-synchronize event must not narrow the review: the
  // event is a full review, and pairing its files with a push range would make
  // the patch and the file list describe different changes.
  assert.deepStrictEqual(calls, ['full'])
  assert.strictEqual(result.window.kind, 'full')
  assert.deepStrictEqual(
    result.files.map((item: PullRequestFile) => item.filename),
    ['whole-pr.ts']
  )
  assert.strictEqual(result.window.reason, 'pull-request-scope')
})

test('a synchronize with a usable push window keeps the push window', async () => {
  const result = await resolveReviewWindowFiles({
    event_type: 'synchronize',
    pr: { base_sha: 'base', head_sha: 'head', previous_head_sha: 'cafe1234' },
    list_push_window_files: async (base_sha) => {
      assert.strictEqual(base_sha, 'cafe1234')
      return { files: [file('pushed.ts')], previous_head_is_ancestor: true }
    },
    list_full_window_files: async () => {
      throw new Error('the full window must not be fetched')
    }
  })

  assert.strictEqual(result.window.kind, 'push')
  assert.strictEqual(result.window.reason, 'synchronize-scope')
  assert.deepStrictEqual(
    result.files.map((item: PullRequestFile) => item.filename),
    ['pushed.ts']
  )
})

test('a synchronize without a previous head falls back to the full window', async () => {
  const result = await resolveReviewWindowFiles({
    event_type: 'synchronize',
    pr: { base_sha: 'base', head_sha: 'head', previous_head_sha: null },
    list_push_window_files: async () => {
      throw new Error('the push window must not be requested')
    },
    list_full_window_files: async () => [file('whole-pr.ts')]
  })

  // Without a previous head there is no push range. Returning an empty file list
  // here would leave the analyzer with a full pull request patch and no files,
  // which is the inconsistency this resolver exists to prevent.
  assert.strictEqual(result.window.kind, 'full')
  assert.strictEqual(result.window.reason, 'synchronize-previous-head-missing')
  assert.deepStrictEqual(
    result.files.map((item: PullRequestFile) => item.filename),
    ['whole-pr.ts']
  )
})

function httpError(
  status: number
): Error & { status: number; response: unknown } {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: {
      status,
      headers: {},
      data: { message: `HTTP ${status}`, errors: [] }
    }
  })
}

test('an unreachable previous head falls back instead of failing the run', async () => {
  // The compare endpoint answers 404 when the base commit is no longer
  // reachable, which surfaces as a rejected promise. Falling back keeps the run
  // alive with a consistent window; letting it propagate fails the whole
  // preparation for a push that GitHub merely rewrote.
  let full_calls = 0
  const result = await resolveReviewWindowFiles({
    event_type: 'synchronize',
    pr: { base_sha: 'base', head_sha: 'head', previous_head_sha: 'gone1234' },
    list_push_window_files: async () => {
      throw httpError(404)
    },
    list_full_window_files: async () => {
      full_calls += 1
      return [file('whole-pr.ts')]
    }
  })

  assert.strictEqual(full_calls, 1)
  assert.strictEqual(result.window.kind, 'full')
  assert.strictEqual(
    result.window.reason,
    'synchronize-previous-head-unreachable'
  )
  assert.deepStrictEqual(
    result.files.map((item: PullRequestFile) => item.filename),
    ['whole-pr.ts']
  )
})

test('a synchronize that changed no files falls back to the full window', async () => {
  // The compare endpoint answers 200 with an empty file list for identical
  // commits. That is not the same as "review nothing": the pull request still
  // has content, so the run keeps a full window rather than an empty one.
  const result = await resolveReviewWindowFiles({
    event_type: 'synchronize',
    pr: { base_sha: 'base', head_sha: 'head', previous_head_sha: 'same1234' },
    list_push_window_files: async () => ({
      files: [],
      previous_head_is_ancestor: true
    }),
    list_full_window_files: async () => [file('whole-pr.ts')]
  })

  assert.strictEqual(result.window.kind, 'full')
  assert.strictEqual(result.window.reason, 'synchronize-no-files-changed')
  assert.deepStrictEqual(
    result.files.map((item: PullRequestFile) => item.filename),
    ['whole-pr.ts']
  )
})

test('compare failures other than 404 propagate instead of triggering a full review', async () => {
  // Falling back on any error would hide real faults and, worse, silently spend
  // a whole pull request review whenever GitHub answers 403/429/5xx or the
  // request merely times out. Each of those must surface to the caller.
  for (const status of [403, 429, 500, 503]) {
    let full_calls = 0
    await assert.rejects(
      resolveReviewWindowFiles({
        event_type: 'synchronize',
        pr: {
          base_sha: 'base',
          head_sha: 'head',
          previous_head_sha: 'prev1234'
        },
        list_push_window_files: async () => {
          throw httpError(status)
        },
        list_full_window_files: async () => {
          full_calls += 1
          return [file('whole-pr.ts')]
        }
      }),
      (error: Error) => error.message === `HTTP ${status}`
    )
    assert.strictEqual(full_calls, 0, `HTTP ${status} must not fetch files`)
  }
})

test('a compare failure without an HTTP status propagates', async () => {
  // A timeout or programming error carries no status, and must not be read as
  // "the previous head is unreachable".
  let full_calls = 0
  await assert.rejects(
    resolveReviewWindowFiles({
      event_type: 'synchronize',
      pr: {
        base_sha: 'base',
        head_sha: 'head',
        previous_head_sha: 'prev1234'
      },
      list_push_window_files: async () => {
        throw new TypeError('fetch failed')
      },
      list_full_window_files: async () => {
        full_calls += 1
        return [file('whole-pr.ts')]
      }
    }),
    /fetch failed/
  )
  assert.strictEqual(full_calls, 0)
})

test('a force-pushed previous head falls back instead of reviewing a broken window', async () => {
  // A force-push replaces the history the push window assumes: the previous head
  // is no longer an ancestor of the current head, the workspace cannot contain
  // it, and the diff range stops describing an incremental change. Continue with
  // the full window rather than review a range the artifacts cannot support.
  let full_calls = 0
  const result = await resolveReviewWindowFiles({
    event_type: 'synchronize',
    pr: { base_sha: 'base', head_sha: 'head', previous_head_sha: 'old1234' },
    list_push_window_files: async () => ({
      files: [file('stale.ts')],
      previous_head_is_ancestor: false
    }),
    list_full_window_files: async () => {
      full_calls += 1
      return [file('whole-pr.ts')]
    }
  })

  assert.strictEqual(full_calls, 1)
  assert.strictEqual(result.window.kind, 'full')
  assert.strictEqual(
    result.window.reason,
    'synchronize-previous-head-not-ancestor'
  )
  assert.deepStrictEqual(
    result.files.map((item: PullRequestFile) => item.filename),
    ['whole-pr.ts']
  )
})
