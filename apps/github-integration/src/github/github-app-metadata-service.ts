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

/** Whether a GitHub user object was authored by this app's bot.
 *
 * This decides whether an existing marker comment/review is reused, so getting it wrong is a
 * duplicated side effect. When the app metadata is unavailable this throws rather than
 * returning false: an empty expectation would silently rewrite every prior publication.
 * Callers run after startup loads `/app`, so unset metadata is a programming/startup fault. */
export function wasAuthoredByCurrentAppBot(
  user:
    | {
        login?: string | null
        type?: string | null
      }
    | null
    | undefined
): boolean {
  const expectedLogin = currentAppBotLogin()
  if (expectedLogin === null) {
    throw new Error(
      'GitHub App metadata is not loaded; cannot attribute a bot-authored object.'
    )
  }
  const login = normalizeLogin(user?.login)
  return user?.type === 'Bot' && login !== null && login === expectedLogin
}
