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

export function setGitHubAppMetadata (metadata: {
  id?: unknown
  slug?: unknown
  name?: unknown
} = {}): void {
  const slug = typeof metadata.slug === 'string' && metadata.slug.trim() !== ''
    ? metadata.slug.trim()
    : null
  const name = typeof metadata.name === 'string' && metadata.name.trim() !== ''
    ? metadata.name.trim()
    : null
  const id = typeof metadata.id === 'number' && Number.isInteger(metadata.id) ? metadata.id : null

  github_app_metadata = {
    id,
    slug,
    name,
    bot_login: slug ? `${slug}[bot]` : null
  }
}

export function getGitHubAppMetadata (): GitHubAppMetadata {
  return { ...github_app_metadata }
}
