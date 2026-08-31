import { getGitHubAppMetadata } from './github-app-metadata-service.js'
import { logInfo } from '../../utils/logger.js'

function asRecord (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizeLogin (login: unknown): string | null {
  return typeof login === 'string' && login.trim() !== ''
    ? login.trim().toLowerCase()
    : null
}

function getCandidateBotLogins (): string[] {
  const appMetadata = getGitHubAppMetadata()

  return [
    appMetadata.bot_login,
    appMetadata.slug ? `${appMetadata.slug}-bot[bot]` : null
  ]
    .map(normalizeLogin)
    .filter((login): login is string => Boolean(login))
}

export function isSelfOriginatedWebhookEvent (payload: unknown): boolean {
  const sender = asRecord(asRecord(payload).sender)
  const sender_login = normalizeLogin(sender.login)
  const senderType = typeof sender.type === 'string'
    ? sender.type
    : null

  if (!sender_login || senderType !== 'Bot') {
    return false
  }

  return getCandidateBotLogins().includes(sender_login)
}

export function logSkippedSelfOriginatedEvent (eventName: string, payload: unknown): void {
  const appMetadata = getGitHubAppMetadata()
  const sender = asRecord(asRecord(payload).sender)
  const sender_login = typeof sender.login === 'string' ? sender.login : '(unknown-sender)'
  const knownBotLogin = appMetadata.bot_login ?? '(unknown-app-bot-login)'

  logInfo('workflow_skipped', {
    app_bot_login: knownBotLogin,
    event: eventName,
    reason: 'self_originated_bot_event',
    sender: sender_login
  })
}
