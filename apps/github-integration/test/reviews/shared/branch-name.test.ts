// Unit coverage for `sanitizeBranchSegment`.
//
// The value comes from a delivery id or issue number and is spliced into `refs/heads/...`. If the
// result is not a valid git ref, `git.createRef` answers 422 and no draft PR is ever opened, so
// the interesting cases are the ones git's `check-ref-format` rejects.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { sanitizeBranchSegment } from '../../../src/reviews/shared/branch-name.js'

/** Whether git accepts the assembled ref. Uses the real predicate the server will apply. */
function gitAcceptsRef(segment: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', `refs/heads/${segment}`], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

test('keeps an already simple segment unchanged', () => {
  assert.strictEqual(sanitizeBranchSegment('delivery-1'), 'delivery-1')
  assert.strictEqual(sanitizeBranchSegment('issue-42'), 'issue-42')
})

test('lowercases and collapses runs of disallowed characters to a single dash', () => {
  assert.strictEqual(sanitizeBranchSegment('Delivery  ID'), 'delivery-id')
  assert.strictEqual(sanitizeBranchSegment('a!!b'), 'a-b')
  assert.strictEqual(sanitizeBranchSegment('a   b'), 'a-b')
})

test('replaces dots, so a ".." or ".lock" cannot survive', () => {
  // git rejects any ref component containing `..`, starting with `.`, or ending with `.lock`.
  // The previous sanitizer preserved dots and produced refs git refused (a 422 and no PR).
  for (const value of ['a..b', '..', '.lock', 'a.b', 'v1.2.3']) {
    const segment = sanitizeBranchSegment(value)
    assert.ok(
      !segment.includes('.'),
      `${value} -> ${segment} must contain no dot`
    )
    // `..` reduces to an empty segment, which cannot form a ref on its own; callers always
    // concatenate it into a larger name, so only a non-empty result has to be ref-valid.
    if (segment !== '') {
      assert.ok(
        gitAcceptsRef(segment),
        `${value} -> ${segment} must be a valid ref`
      )
    }
  }
})

test('trims leading and trailing separators, which git also rejects', () => {
  assert.strictEqual(sanitizeBranchSegment('-abc'), 'abc')
  assert.strictEqual(sanitizeBranchSegment('abc-'), 'abc')
  assert.strictEqual(sanitizeBranchSegment('/abc/'), 'abc')
  assert.strictEqual(sanitizeBranchSegment('--abc--'), 'abc')
})

test('preserves slashes between segments but never leaves an empty one', () => {
  assert.strictEqual(sanitizeBranchSegment('a/b'), 'a/b')
  assert.strictEqual(sanitizeBranchSegment('a//b'), 'a/b')
  assert.strictEqual(sanitizeBranchSegment('/a/b/'), 'a/b')
})

test('coerces non-string values instead of throwing', () => {
  // The value may come from a contract field typed `unknown`.
  assert.strictEqual(sanitizeBranchSegment(undefined), '')
  assert.strictEqual(sanitizeBranchSegment(null), '')
  assert.strictEqual(sanitizeBranchSegment(42), '42')
})

test('every sanitized value is accepted by git for the inputs that matter', () => {
  for (const value of [
    'delivery-1',
    'a..b',
    '.lock',
    '..',
    'a b',
    'a\\b',
    'CAPS',
    'a/b',
    '---',
    '!!!'
  ]) {
    const segment = sanitizeBranchSegment(value)
    // An empty segment cannot form a ref; callers append a run id, so allow it here but require
    // that any non-empty result is a ref git accepts.
    if (segment !== '') {
      assert.ok(
        gitAcceptsRef(segment),
        `${value} -> ${segment} must be a valid ref`
      )
    }
  }
})
