import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentAppBotLogin,
  isCurrentAppBotLogin,
  normalizeLogin,
  setGitHubAppMetadata,
  wasAuthoredByCurrentAppBot
} from '../../src/github/github-app-metadata-service.js'
import { isSelfOriginatedWebhookEvent } from '../../src/github/webhook-origin-guard.js'
import { classifyPublicationFailure } from '../../src/control-plane/publication-failure.js'

test.beforeEach(() => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
})

test('normalizeLogin lowercases and trims, and rejects non-strings', () => {
  assert.strictEqual(
    normalizeLogin('  Sec-Review-Bot[bot] '),
    'sec-review-bot[bot]'
  )
  assert.strictEqual(normalizeLogin(''), null)
  assert.strictEqual(normalizeLogin('   '), null)
  assert.strictEqual(normalizeLogin(undefined), null)
  assert.strictEqual(normalizeLogin(42), null)
})

test('currentAppBotLogin derives the bot login from the app slug', () => {
  assert.strictEqual(currentAppBotLogin(), 'sec-review-bot[bot]')
  setGitHubAppMetadata({})
  assert.strictEqual(currentAppBotLogin(), null)
})

test('wasAuthoredByCurrentAppBot recognizes only this app bot', () => {
  assert.strictEqual(
    wasAuthoredByCurrentAppBot({
      login: 'Sec-Review-Bot[bot]',
      type: 'Bot'
    }),
    true
  )
  // A different bot is not us, even with a similar login.
  assert.strictEqual(
    wasAuthoredByCurrentAppBot({ login: 'other-bot[bot]', type: 'Bot' }),
    false
  )
  // A human account with the same login string is not a bot.
  assert.strictEqual(
    wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'User' }),
    false
  )
  assert.strictEqual(wasAuthoredByCurrentAppBot(null), false)
})

test('isCurrentAppBotLogin compares only a stored login, and says so', () => {
  // A persisted PR author keeps a login but no user `type`. This narrower check exists so a
  // caller does not fabricate `type: 'Bot'` and silently make half of the full guard true.
  assert.strictEqual(isCurrentAppBotLogin('Sec-Review-Bot[bot]'), true)
  assert.strictEqual(isCurrentAppBotLogin('other-bot[bot]'), false)
  assert.strictEqual(isCurrentAppBotLogin('alice'), false)
  assert.strictEqual(isCurrentAppBotLogin(null), false)
  // It fails closed exactly like the full check: no metadata means no safe answer.
  setGitHubAppMetadata({})
  assert.throws(
    () => isCurrentAppBotLogin('sec-review-bot[bot]'),
    /metadata is not loaded/
  )
})

test('wasAuthoredByCurrentAppBot still rejects a human account with a bot login', () => {
  // The full check keeps both halves: the login must match AND the entity must be a Bot. This
  // is why callers without a `type` use the narrower function instead of passing a fake one.
  assert.strictEqual(
    wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'User' }),
    false
  )
  assert.strictEqual(
    wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'Bot' }),
    true
  )
})

test('wasAuthoredByCurrentAppBot refuses to attribute when metadata is unloaded', () => {
  // With no app metadata there is no safe expectation: returning false would let a marker
  // be re-published, so the helper must surface the startup fault instead.
  setGitHubAppMetadata({})
  assert.throws(
    () =>
      wasAuthoredByCurrentAppBot({
        login: 'sec-review-bot[bot]',
        type: 'Bot'
      }),
    /metadata is not loaded/
  )
})

test('unattributable metadata is a deterministic publish failure, not a retryable one', () => {
  // The publisher classifies a fault without a response status as "unknown, retry". An
  // unattributable object can never be answered by re-claiming the same publication, so without
  // a deterministic code this turned a configuration mistake into an endless retry loop.
  setGitHubAppMetadata({})
  let thrown: unknown
  try {
    wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'Bot' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error, 'unattributable metadata must throw')
  assert.deepStrictEqual(
    (({ retry, code, reason }) => ({ retry, code, reason }))(
      classifyPublicationFailure(thrown)
    ),
    {
      retry: false,
      code: 'APP_METADATA_UNAVAILABLE',
      reason: 'deterministic-publish-result'
    }
  )
})

test('isSelfOriginatedWebhookEvent ignores this app bot and other bots when attributing', () => {
  const event = (login: string, type: string) => ({
    sender: { login, type }
  })
  assert.strictEqual(
    isSelfOriginatedWebhookEvent(event('sec-review-bot[bot]', 'Bot')),
    true,
    'our own bot event must be skipped to avoid a publish/trigger loop'
  )
  assert.strictEqual(
    isSelfOriginatedWebhookEvent(event('human', 'User')),
    false,
    'a human event is external'
  )
  // An unattributable bot is treated as self-originated (fail closed) rather than processed.
  setGitHubAppMetadata({})
  assert.strictEqual(
    isSelfOriginatedWebhookEvent(event('sec-review-bot[bot]', 'Bot')),
    true
  )
})
