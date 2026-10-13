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
    repair_mode: null
  })
})

test('extractCommentCommand parses the no-test-changes modifier', () => {
  assert.deepEqual(extractCommentCommand('@sec-review-bot review no-test-changes'), {
    command: 'review',
    mention: 'sec-review-bot',
    repair_mode: 'no-test-changes'
  })
})

test('extractCommentCommand rejects the audit and repair objective words', () => {
  // The review objective is not part of a comment command: the GitHub integration always
  // audits an issue, and `repair` is reserved for trusted callers. A comment naming either
  // word is not a command at all.
  assert.equal(extractCommentCommand('@sec-review-bot review audit'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review repair'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review repair no-test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review audit no-test-changes'), null)
})

test('extractCommentCommand rejects unexpected arguments', () => {
  assert.equal(extractCommentCommand('@sec-review-bot review maybe'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review no-test-changes extra'), null)
  assert.equal(extractCommentCommand('@sec-review-bot approve'), null)
})

test('extractCommentCommand ignores quoted commands', () => {
  assert.equal(extractCommentCommand('> @sec-review-bot review\n\nI meant this earlier.'), null)
})

test('extractCommentCommand parses a command after quoted text', () => {
  assert.deepEqual(
    extractCommentCommand('> @sec-review-bot review\n\n@sec-review-bot review no-test-changes'),
    {
      command: 'review',
      mention: 'sec-review-bot',
      repair_mode: 'no-test-changes'
    }
  )
})
