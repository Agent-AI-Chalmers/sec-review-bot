import assert from 'node:assert/strict'
import test from 'node:test'

import { extractCommentCommand } from '../../infrastructure/github/comment-command-service.js'
import { setGitHubAppMetadata } from '../../infrastructure/github/github-app-metadata-service.js'

test('extractCommentCommand parses review audit intent', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.deepEqual(extractCommentCommand('@sec-review-bot review audit'), {
    command: 'review',
    mention: 'sec-review-bot',
    issue_review_objective: 'audit',
    repair_mode: null
  })
})

test('extractCommentCommand parses review repair intent', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.deepEqual(extractCommentCommand('@sec-review-bot review repair'), {
    command: 'review',
    mention: 'sec-review-bot',
    issue_review_objective: 'repair',
    repair_mode: null
  })
})

test('extractCommentCommand parses review repair no-test-changes mode', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.deepEqual(extractCommentCommand('@sec-review-bot review repair no-test-changes'), {
    command: 'review',
    mention: 'sec-review-bot',
    issue_review_objective: 'repair',
    repair_mode: 'no-test-changes'
  })
})

test('extractCommentCommand parses plain review no-test-changes mode', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.deepEqual(extractCommentCommand('@sec-review-bot review no-test-changes'), {
    command: 'review',
    mention: 'sec-review-bot',
    issue_review_objective: null,
    repair_mode: 'no-test-changes'
  })
})

test('extractCommentCommand keeps plain review command without issue intent', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.deepEqual(extractCommentCommand('@sec-review-bot review'), {
    command: 'review',
    mention: 'sec-review-bot',
    issue_review_objective: null,
    repair_mode: null
  })
})

test('extractCommentCommand rejects unexpected command arguments', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.equal(extractCommentCommand('@sec-review-bot review maybe'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review audit no-test-changes'), null)
  assert.equal(extractCommentCommand('@sec-review-bot review repair no-test-changes extra'), null)
})

test('extractCommentCommand ignores quoted commands', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.equal(extractCommentCommand('> @sec-review-bot review\n\nI meant this earlier.'), null)
})

test('extractCommentCommand parses command after quoted text', () => {
  setGitHubAppMetadata({
    id: 1,
    slug: 'sec-review-bot',
    name: 'Sec Review Bot'
  })

  assert.deepEqual(extractCommentCommand('> @sec-review-bot review\n\n@sec-review-bot review repair'), {
    command: 'review',
    mention: 'sec-review-bot',
    issue_review_objective: 'repair',
    repair_mode: null
  })
})
