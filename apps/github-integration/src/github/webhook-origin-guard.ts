import {
  currentAppBotLogin,
  getGitHubAppMetadata,
  normalizeLogin
} from './github-app-metadata-service.js'
import { logInfo } from '../utils/logger.js'

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function isSelfOriginatedWebhookEvent(payload: unknown): boolean {
  const sender = asRecord(asRecord(payload).sender)
  const sender_login = normalizeLogin(sender.login)
  const senderType = typeof sender.type === 'string' ? sender.type : null

  if (!sender_login || senderType !== 'Bot') {
    return false
  }

  // If the app metadata is not loaded we cannot tell our own bot from another, and treating
  // our own event as external can loop (a review this app just published triggers another
  // review). Fail closed rather than process an unattributable bot event.
  //
  // Be aware of the blast radius: with no metadata this returns true for EVERY bot sender, so
  // no bot-originated webhook is handled at all. The running service cannot reach this state —
  // `app.ts` refuses to start without `/app` metadata — but a script or test that calls the
  // guard on its own will see bot events silently skipped rather than processed.
  const expectedLogin = currentAppBotLogin()
  if (expectedLogin === null) return true
  return sender_login === expectedLogin
}

export function logSkippedSelfOriginatedEvent(
  eventName: string,
  payload: unknown
): void {
  const appMetadata = getGitHubAppMetadata()
  const sender = asRecord(asRecord(payload).sender)
  const sender_login =
    typeof sender.login === 'string' ? sender.login : '(unknown-sender)'
  const knownBotLogin = appMetadata.bot_login ?? '(unknown-app-bot-login)'

  logInfo('workflow_skipped', {
    app_bot_login: knownBotLogin,
    event: eventName,
    reason: 'self_originated_bot_event',
    sender: sender_login
  })
}
