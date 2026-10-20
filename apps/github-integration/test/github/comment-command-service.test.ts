import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractCommentCommand,
  unmatchedMentions
} from '../../src/github/comment-command-service.js'
import { setGitHubAppMetadata } from '../../src/github/github-app-metadata-service.js'

setGitHubAppMetadata({
  id: 1,
  slug: 'sec-review-bot',
  name: 'Sec Review Bot'
})

test('extractCommentCommand parses a plain review command', () => {
  assert.deepStrictEqual(extractCommentCommand('@sec-review-bot review'), {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
})

test('extractCommentCommand parses the test-changes deny value', () => {
  assert.deepStrictEqual(
    extractCommentCommand('@sec-review-bot review --test-changes deny'),
    {
      command: 'review',
      mention: 'sec-review-bot',
      test_changes: 'deny',
      open_pr: false
    }
  )
  assert.deepStrictEqual(
    extractCommentCommand('@sec-review-bot review --test-changes allow'),
    {
      command: 'review',
      mention: 'sec-review-bot',
      test_changes: 'allow',
      open_pr: false
    }
  )
})

test('extractCommentCommand parses the open-pr flag', () => {
  assert.deepStrictEqual(
    extractCommentCommand('@sec-review-bot review --open-pr'),
    {
      command: 'review',
      mention: 'sec-review-bot',
      test_changes: 'allow',
      open_pr: true
    }
  )
})

test('extractCommentCommand parses combined flags in any order', () => {
  const expected = {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'deny',
    open_pr: true
  }
  assert.deepStrictEqual(
    extractCommentCommand(
      '@sec-review-bot review --open-pr --test-changes deny'
    ),
    expected
  )
  assert.deepStrictEqual(
    extractCommentCommand(
      '@sec-review-bot review --test-changes deny --open-pr'
    ),
    expected
  )
})

test('extractCommentCommand rejects a bare or invalid test-changes value', () => {
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --open-pr=true'),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --test-changes'),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --test-changes maybe'),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --test-changes=deny'),
    null
  )
})

test('extractCommentCommand rejects unknown flags', () => {
  // A typo must fail the whole command rather than being silently ignored.
  assert.strictEqual(
    extractCommentCommand(
      '@sec-review-bot review --repair-mode=no-test-changes'
    ),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --no-test-changes'),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --bogus=1'),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review --bogus'),
    null
  )
})

test('extractCommentCommand rejects the old positional forms and the objective words', () => {
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review no-test-changes'),
    null
  )
  assert.strictEqual(extractCommentCommand('@sec-review-bot review deny'), null)
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review audit'),
    null
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot review repair'),
    null
  )
  assert.strictEqual(extractCommentCommand('@sec-review-bot approve'), null)
})

test('extractCommentCommand ignores quoted commands', () => {
  assert.strictEqual(
    extractCommentCommand('> @sec-review-bot review\n\nI meant this earlier.'),
    null
  )
})

test('extractCommentCommand parses a command after quoted text', () => {
  assert.deepStrictEqual(
    extractCommentCommand(
      '> @sec-review-bot review\n\n@sec-review-bot review --test-changes deny'
    ),
    {
      command: 'review',
      mention: 'sec-review-bot',
      test_changes: 'deny',
      open_pr: false
    }
  )
})

test('extractCommentCommand accepts the bot login and bare slug, not invented variants', () => {
  // GitHub assigns exactly `<slug>[bot]` as the bot login. The bare slug is also real because
  // users type the app name. A guessed `-bot` spelling is neither: accepting it would let a
  // different account (`@sec-review-bot-bot`, `@sec-review-bot-bot[bot]`) trigger a review as if
  // it were this app.
  assert.deepStrictEqual(extractCommentCommand('@sec-review-bot[bot] review'), {
    command: 'review',
    mention: 'sec-review-bot[bot]',
    test_changes: 'allow',
    open_pr: false
  })
  assert.deepStrictEqual(extractCommentCommand('@sec-review-bot review'), {
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot-bot review'),
    null,
    'an invented -bot spelling must not be treated as this app'
  )
  assert.strictEqual(
    extractCommentCommand('@sec-review-bot-bot[bot] review'),
    null,
    'an invented -bot[bot] spelling must not be treated as this app'
  )
})

test('unmatchedMentions names the mentions an ignored comment addressed', () => {
  // A comment addressing the app with a spelling it does not answer would otherwise be dropped
  // with no trace, which reads as "the app is broken". The diagnostic has to list the mention
  // that was actually written, and stay silent when the comment addressed this app.
  assert.deepStrictEqual(
    unmatchedMentions('@sec-review-bot-bot review'),
    ['sec-review-bot-bot'],
    'an unaccepted -bot spelling is reported so the reader can see why nothing happened'
  )
  assert.deepStrictEqual(
    unmatchedMentions('@sec-review-bot review'),
    [],
    'a recognised mention is not an unmatched one'
  )
  assert.deepStrictEqual(
    unmatchedMentions('@sec-review-bot[bot] review'),
    [],
    'the bot login is a recognised mention too'
  )
  assert.deepStrictEqual(
    unmatchedMentions('> @sec-review-bot-bot review'),
    [],
    'quoted history is not a mention the reader typed now'
  )
  assert.deepStrictEqual(unmatchedMentions('no mention here'), [])
  assert.deepStrictEqual(
    unmatchedMentions('please ask @someone-else about this'),
    ['someone-else']
  )
})

test('unmatchedMentions sees a mention wrapped in markdown or punctuation', () => {
  // Readers wrap handles in markdown constantly. A diagnostic that only understood a bare
  // `@handle` after whitespace would be silent for exactly the spellings people type, and a
  // silent diagnostic is worse than none: it looks like the app accepted the command.
  for (const body of [
    '(@sec-review-bot-bot) review',
    '**@sec-review-bot-bot** review',
    '`@sec-review-bot-bot review`',
    '_@sec-review-bot-bot_ review',
    '"@sec-review-bot-bot" review',
    '- @sec-review-bot-bot',
    'please @sec-review-bot-bot review.'
  ]) {
    assert.deepStrictEqual(
      unmatchedMentions(body),
      ['sec-review-bot-bot'],
      `a wrapped mention must still be reported: ${body}`
    )
  }
  assert.deepStrictEqual(
    unmatchedMentions('@sec-review-bot-bot: review'),
    ['sec-review-bot-bot'],
    'a trailing colon belongs to the sentence, not to the login'
  )
})

test('unmatchedMentions sees a mention wrapped in underscore emphasis', () => {
  // `__bold italic__` is ordinary GitHub markdown, and an underscore-prefixed word followed by a
  // mention (`x_@bot`) is not an address either. Deciding from the left neighbour alone would
  // discard both, so the mail-domain shape is what separates them.
  for (const body of [
    '__@sec-review-bot-bot__ please review',
    '__@sec-review-bot-bot',
    '___@sec-review-bot-bot___',
    '_@sec-review-bot-bot_'
  ]) {
    assert.deepStrictEqual(
      unmatchedMentions(body),
      ['sec-review-bot-bot'],
      `underscore emphasis must not hide the mention: ${body}`
    )
  }
  assert.deepStrictEqual(
    unmatchedMentions('x_@sec-review-bot-bot'),
    ['sec-review-bot-bot'],
    'a word ending in an underscore is not an email local part'
  )
})

test('unmatchedMentions ignores email addresses and URL paths', () => {
  // The left boundary accepts punctuation so markdown works, which makes a naive pattern report
  // every address as a mention. These shapes carry an `@` but never name an account to notify.
  for (const body of [
    'foo@bar.com',
    'contact me at foo@bar.com please',
    'see https://user@example.com/path',
    'https://github.com/@user',
    '[link](https://x.test/@sec-review-bot-bot)',
    'mailto:foo@bar.com',
    'user_name@example.com',
    'foo_@bar.com',
    '_@example.com',
    'EMAIL@EXAMPLE.COM'
  ]) {
    assert.deepStrictEqual(
      unmatchedMentions(body),
      [],
      `an address is not a mention: ${body}`
    )
  }
  assert.deepStrictEqual(
    unmatchedMentions('foo@bar.com then @real-mention'),
    ['real-mention'],
    'a real mention next to an address is still reported'
  )
})
