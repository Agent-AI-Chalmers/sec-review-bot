import { expect, test } from 'vitest'

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
  expect(extractCommentCommand('@sec-review-bot review')).toStrictEqual({
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
})

test('extractCommentCommand parses the test-changes deny value', () => {
  expect(extractCommentCommand('@sec-review-bot review --test-changes deny')).toStrictEqual({
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'deny',
    open_pr: false
  })
  expect(extractCommentCommand('@sec-review-bot review --test-changes allow')).toStrictEqual({
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
})

test('extractCommentCommand parses the open-pr flag', () => {
  expect(extractCommentCommand('@sec-review-bot review --open-pr')).toStrictEqual({
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
  expect(
    extractCommentCommand('@sec-review-bot review --open-pr --test-changes deny')
  ).toStrictEqual(expected)
  expect(
    extractCommentCommand('@sec-review-bot review --test-changes deny --open-pr')
  ).toStrictEqual(expected)
})

test('extractCommentCommand rejects a bare or invalid test-changes value', () => {
  expect(extractCommentCommand('@sec-review-bot review --open-pr=true')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review --test-changes')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review --test-changes maybe')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review --test-changes=deny')).toBe(null)
})

test('extractCommentCommand rejects unknown flags', () => {
  // A typo must fail the whole command rather than being silently ignored.
  expect(extractCommentCommand('@sec-review-bot review --repair-mode=no-test-changes')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review --no-test-changes')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review --bogus=1')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review --bogus')).toBe(null)
})

test('extractCommentCommand rejects the old positional forms and the objective words', () => {
  expect(extractCommentCommand('@sec-review-bot review no-test-changes')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review deny')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review audit')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot review repair')).toBe(null)
  expect(extractCommentCommand('@sec-review-bot approve')).toBe(null)
})

test('extractCommentCommand ignores quoted commands', () => {
  expect(extractCommentCommand('> @sec-review-bot review\n\nI meant this earlier.')).toBe(null)
})

test('extractCommentCommand parses a command after quoted text', () => {
  expect(
    extractCommentCommand('> @sec-review-bot review\n\n@sec-review-bot review --test-changes deny')
  ).toStrictEqual({
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'deny',
    open_pr: false
  })
})

test('extractCommentCommand accepts the bot login and bare slug, not invented variants', () => {
  // GitHub assigns exactly `<slug>[bot]` as the bot login. The bare slug is also real because
  // users type the app name. A guessed `-bot` spelling is neither: accepting it would let a
  // different account (`@sec-review-bot-bot`, `@sec-review-bot-bot[bot]`) trigger a review as if
  // it were this app.
  expect(extractCommentCommand('@sec-review-bot[bot] review')).toStrictEqual({
    command: 'review',
    mention: 'sec-review-bot[bot]',
    test_changes: 'allow',
    open_pr: false
  })
  expect(extractCommentCommand('@sec-review-bot review')).toStrictEqual({
    command: 'review',
    mention: 'sec-review-bot',
    test_changes: 'allow',
    open_pr: false
  })
  expect(
    extractCommentCommand('@sec-review-bot-bot review'),
    'an invented -bot spelling must not be treated as this app'
  ).toBe(null)
  expect(
    extractCommentCommand('@sec-review-bot-bot[bot] review'),
    'an invented -bot[bot] spelling must not be treated as this app'
  ).toBe(null)
})

test('unmatchedMentions names the mentions an ignored comment addressed', () => {
  // A comment addressing the app with a spelling it does not answer would otherwise be dropped
  // with no trace, which reads as "the app is broken". The diagnostic has to list the mention
  // that was actually written, and stay silent when the comment addressed this app.
  expect(
    unmatchedMentions('@sec-review-bot-bot review'),
    'an unaccepted -bot spelling is reported so the reader can see why nothing happened'
  ).toStrictEqual(['sec-review-bot-bot'])
  expect(
    unmatchedMentions('@sec-review-bot review'),
    'a recognised mention is not an unmatched one'
  ).toStrictEqual([])
  expect(
    unmatchedMentions('@sec-review-bot[bot] review'),
    'the bot login is a recognised mention too'
  ).toStrictEqual([])
  expect(
    unmatchedMentions('> @sec-review-bot-bot review'),
    'quoted history is not a mention the reader typed now'
  ).toStrictEqual([])
  expect(unmatchedMentions('no mention here')).toStrictEqual([])
  expect(unmatchedMentions('please ask @someone-else about this')).toStrictEqual(['someone-else'])
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
    expect(
      unmatchedMentions(body),
      `a wrapped mention must still be reported: ${body}`
    ).toStrictEqual(['sec-review-bot-bot'])
  }
  expect(
    unmatchedMentions('@sec-review-bot-bot: review'),
    'a trailing colon belongs to the sentence, not to the login'
  ).toStrictEqual(['sec-review-bot-bot'])
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
    expect(
      unmatchedMentions(body),
      `underscore emphasis must not hide the mention: ${body}`
    ).toStrictEqual(['sec-review-bot-bot'])
  }
  expect(
    unmatchedMentions('x_@sec-review-bot-bot'),
    'a word ending in an underscore is not an email local part'
  ).toStrictEqual(['sec-review-bot-bot'])
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
    expect(unmatchedMentions(body), `an address is not a mention: ${body}`).toStrictEqual([])
  }
  expect(
    unmatchedMentions('foo@bar.com then @real-mention'),
    'a real mention next to an address is still reported'
  ).toStrictEqual(['real-mention'])
})
