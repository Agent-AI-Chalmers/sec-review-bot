import { expect, beforeEach, test } from 'vitest'

import {
  currentAppBotLogin,
  isCurrentAppBotLogin,
  normalizeLogin,
  setGitHubAppMetadata,
  wasAuthoredByCurrentAppBot
} from '../../src/github/github-app-metadata-service.js'
import { isSelfOriginatedWebhookEvent } from '../../src/github/webhook-origin-guard.js'
import { classifyPublicationFailure } from '../../src/review-runs/publication-failure.js'

beforeEach(() => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
})

test('normalizeLogin lowercases and trims, and rejects non-strings', () => {
  expect(normalizeLogin('  Sec-Review-Bot[bot] ')).toBe('sec-review-bot[bot]')
  expect(normalizeLogin('')).toBe(null)
  expect(normalizeLogin('   ')).toBe(null)
  expect(normalizeLogin(undefined)).toBe(null)
  expect(normalizeLogin(42)).toBe(null)
})

test('currentAppBotLogin derives the bot login from the app slug', () => {
  expect(currentAppBotLogin()).toBe('sec-review-bot[bot]')
  setGitHubAppMetadata({})
  expect(currentAppBotLogin()).toBe(null)
})

test('wasAuthoredByCurrentAppBot recognizes only this app bot', () => {
  expect(
    wasAuthoredByCurrentAppBot({
      login: 'Sec-Review-Bot[bot]',
      type: 'Bot'
    })
  ).toBe(true)
  // A different bot is not us, even with a similar login.
  expect(wasAuthoredByCurrentAppBot({ login: 'other-bot[bot]', type: 'Bot' })).toBe(false)
  // A human account with the same login string is not a bot.
  expect(wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'User' })).toBe(false)
  expect(wasAuthoredByCurrentAppBot(null)).toBe(false)
})

test('isCurrentAppBotLogin compares only a stored login, and says so', () => {
  // A persisted PR author keeps a login but no user `type`. This narrower check exists so a
  // caller does not fabricate `type: 'Bot'` and silently make half of the full guard true.
  expect(isCurrentAppBotLogin('Sec-Review-Bot[bot]')).toBe(true)
  expect(isCurrentAppBotLogin('other-bot[bot]')).toBe(false)
  expect(isCurrentAppBotLogin('alice')).toBe(false)
  expect(isCurrentAppBotLogin(null)).toBe(false)
  // It fails closed exactly like the full check: no metadata means no safe answer.
  setGitHubAppMetadata({})
  expect(() => isCurrentAppBotLogin('sec-review-bot[bot]')).toThrow(/metadata is not loaded/)
})

test('wasAuthoredByCurrentAppBot still rejects a human account with a bot login', () => {
  // The full check keeps both halves: the login must match AND the entity must be a Bot. This
  // is why callers without a `type` use the narrower function instead of passing a fake one.
  expect(wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'User' })).toBe(false)
  expect(wasAuthoredByCurrentAppBot({ login: 'sec-review-bot[bot]', type: 'Bot' })).toBe(true)
})

test('wasAuthoredByCurrentAppBot refuses to attribute when metadata is unloaded', () => {
  // With no app metadata there is no safe expectation: returning false would let a marker
  // be re-published, so the helper must surface the startup fault instead.
  setGitHubAppMetadata({})
  expect(() =>
    wasAuthoredByCurrentAppBot({
      login: 'sec-review-bot[bot]',
      type: 'Bot'
    })
  ).toThrow(/metadata is not loaded/)
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
  expect.assert(thrown instanceof Error, 'unattributable metadata must throw')
  expect(
    (({ retry, code, reason }) => ({ retry, code, reason }))(classifyPublicationFailure(thrown))
  ).toStrictEqual({
    retry: false,
    code: 'APP_METADATA_UNAVAILABLE',
    reason: 'deterministic-publish-result'
  })
})

test('isSelfOriginatedWebhookEvent ignores this app bot and other bots when attributing', () => {
  const event = (login: string, type: string) => ({
    sender: { login, type }
  })
  expect(
    isSelfOriginatedWebhookEvent(event('sec-review-bot[bot]', 'Bot')),
    'our own bot event must be skipped to avoid a publish/trigger loop'
  ).toBe(true)
  expect(isSelfOriginatedWebhookEvent(event('human', 'User')), 'a human event is external').toBe(
    false
  )
  // An unattributable bot is treated as self-originated (fail closed) rather than processed.
  setGitHubAppMetadata({})
  expect(isSelfOriginatedWebhookEvent(event('sec-review-bot[bot]', 'Bot'))).toBe(true)
})
