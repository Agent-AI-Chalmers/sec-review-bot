import { DeterministicRunnerPublishError } from '../runner/publish-error.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../runner/publish-error-code.js'

interface GitHubAppMetadata {
  id: number | null
  slug: string | null
  name: string | null
  bot_login: string | null
}

let github_app_metadata: GitHubAppMetadata = {
  id: null,
  slug: null,
  name: null,
  bot_login: null
}

export function setGitHubAppMetadata(
  metadata: {
    id?: unknown
    slug?: unknown
    name?: unknown
  } = {}
): void {
  const slug =
    typeof metadata.slug === 'string' && metadata.slug.trim() !== ''
      ? metadata.slug.trim()
      : null
  const name =
    typeof metadata.name === 'string' && metadata.name.trim() !== ''
      ? metadata.name.trim()
      : null
  const id =
    typeof metadata.id === 'number' && Number.isInteger(metadata.id)
      ? metadata.id
      : null

  github_app_metadata = {
    id,
    slug,
    name,
    bot_login: slug ? `${slug}[bot]` : null
  }
}

export function getGitHubAppMetadata(): GitHubAppMetadata {
  return { ...github_app_metadata }
}

/** Normalize a GitHub login for comparison. GitHub logins are case-insensitive. */
export function normalizeLogin(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().toLowerCase()
    : null
}

/** The login this app posts as, normalized, or null when the app metadata has not been loaded.
 *
 * GitHub App bots comment as `<slug>[bot]`. `bot_login` is that value; it is derived from the
 * authenticated `/app` response at startup. We deliberately do not guess alternate spellings:
 * matching the wrong login would treat another bot's marker as our own and suppress a real
 * side effect. */
export function currentAppBotLogin(): string | null {
  return normalizeLogin(github_app_metadata.bot_login)
}

/** The expected app bot login, or a deterministic error when it is unknown.
 *
 * Attribution decides whether an existing marker comment/review is reused, so getting it wrong
 * is a duplicated side effect. Without a known login there is no safe expectation: returning
 * `false` would silently rewrite every prior publication. Callers run after startup loads
 * `/app`, so unset metadata is a programming/startup fault — and the error is deterministic, not
 * transient, so a publisher cannot turn it into an endless retry loop. */
function requireAppBotLogin(): string {
  const expectedLogin = currentAppBotLogin()
  if (expectedLogin === null) {
    throw new DeterministicRunnerPublishError(
      'GitHub App metadata is not loaded; cannot attribute a bot-authored object.',
      RUNNER_PUBLISH_ERROR_CODES.app_metadata_unavailable
    )
  }
  return expectedLogin
}

/** Whether a GitHub user object was authored by this app's bot.
 *
 * This is the full check: the object must be a Bot entity *and* carry this app's login. Use it
 * for anything shaped like a GitHub user, because a human account can reuse a bot-looking login
 * string. For a stored login that is already known to name a bot identity, use
 * `isCurrentAppBotLogin` instead of fabricating a `type`. */
export function wasAuthoredByCurrentAppBot(
  user:
    | {
        login?: string | null
        type?: string | null
      }
    | null
    | undefined
): boolean {
  const expectedLogin = requireAppBotLogin()
  const login = normalizeLogin(user?.login)
  return user?.type === 'Bot' && login !== null && login === expectedLogin
}

/** Whether a stored login names this app's bot, without a user `type` to check.
 *
 * Some persisted records keep only a login (for example a pull request author) and the caller
 * has already decided the entity is a bot. This function does not skip the type check as a
 * convenience: it is a narrower contract that says exactly that, so a reader is never led to
 * believe the full `type === 'Bot'` guard ran. */
export function isCurrentAppBotLogin(login: unknown): boolean {
  const expectedLogin = requireAppBotLogin()
  const candidate = normalizeLogin(login)
  return candidate !== null && candidate === expectedLogin
}
