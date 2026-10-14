import assert from 'node:assert/strict'
import test from 'node:test'

import { extractCommentCommand } from '../../src/github/comment-command-service.js'
import { setGitHubAppMetadata } from '../../src/github/github-app-metadata-service.js'

setGitHubAppMetadata({
  id: 1,
  slug: 'sec-review-bot',
  name: 'Sec Review Bot'
})

test('extractCommentCommand parses a plain review command', () => {
  assert.deepEqual(extractCommentCommand('@sec-review-bot review'), {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
})

test('extractCommentCommand parses the test-changes deny value', () => {
  assert.deepEqual(extractCommentCommand('@sec-review-bot review --test-changes deny'), {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'deny',
    open_pr: false
  })
  assert.deepEqual(extractCommentCommand('@sec-review-bot review --test-changes allow'), {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
})

test('extractCommentCommand parses the open-pr flag', () => {
  assert.deepEqual(extractCommentCommand('@sec-review-bot review --open-pr'), {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: true
  })
})

test('extractCommentCommand parses combined flags in any order', () => {
  const expected = {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'deny',
    open_pr: true
  }
  assert.deepEqual(
    extractCommentCommand('@sec-review-bot review --open-pr --test-changes deny'),
    expected
  )
  assert.deepEqual(
    extractCommentCommand('@sec-review-bot review --test-changes deny --open-pr'),
    expected
  )
})

test('extractCommentCommand rejects a bare or invalid test-changes value', () => {
  assert.equal(extractCommentCommand('@sec-review-bot review --open-pr=true'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --test-changes maybe'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --test-changes=deny'), null)
})

test('extractCommentCommand rejects unknown flags', () => {
  // A typo must fail the whole command rather than being silently ignored.
  assert.equal(extractCommentCommand('@sec-review-bot review --repair-mode=no-test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --no-test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --bogus=1'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --bogus'), null)
})

test('extractCommentCommand rejects the old positional forms and the objective words', () => {
  assert.equal(extractCommentCommand('@sec-review-bot review no-test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review deny'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review audit'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review repair'), null)
  assert.equal(extractCommentCommand('@sec-review-bot approve'), null)
})

test('extractCommentCommand ignores quoted commands', () => {
  assert.equal(extractCommentCommand('> @sec-review-bot review\n\nI meant this earlier.'), null)
})

test('extractCommentCommand parses a command after quoted text', () => {
  assert.deepEqual(
    extractCommentCommand('> @sec-review-bot review\n\n@sec-review-bot review --test-changes deny'),
    {
      command: 'review',
      mention: 'sec-review-bot',
      test_changes: 'deny',
      open_pr: false
    }
  )
})
