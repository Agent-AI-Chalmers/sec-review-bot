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

test('extractCommentCommand parses the repair-mode option', () => {
  assert.deepEqual(extractCommentCommand('@sec-review-bot review --repair-mode=no-test-changes'), {
    command: 'review',
    mention: 'sec-review-bot',
    repair_mode: 'no-test-changes'
  })
  assert.deepEqual(
    extractCommentCommand('@sec-review-bot review --repair-mode=test-changes-allowed'),
    { command: 'review', mention: 'sec-review-bot', repair_mode: 'test-changes-allowed' }
  )
})

test('extractCommentCommand rejects unknown options and values', () => {
  // A typo must fail the whole command rather than being silently ignored.
  assert.equal(extractCommentCommand('@sec-review-bot review --repair-mode=bogus'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --bogus=1'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review --repair-mode'), null)
})

test('extractCommentCommand rejects the old positional forms and the objective words', () => {
  assert.equal(extractCommentCommand('@sec-review-bot review no-test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review audit'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review repair'), null)
  assert.equal(extractCommentCommand('@sec-review-bot approve'), null)
})

test('extractCommentCommand ignores quoted commands', () => {
  assert.equal(extractCommentCommand('> @sec-review-bot review\n\nI meant this earlier.'), null)
})

test('extractCommentCommand parses a command after quoted text', () => {
  assert.deepEqual(
    extractCommentCommand(
      '> @sec-review-bot review\n\n@sec-review-bot review --repair-mode=no-test-changes'
    ),
    { command: 'review', mention: 'sec-review-bot', repair_mode: 'no-test-changes' }
  )
})
