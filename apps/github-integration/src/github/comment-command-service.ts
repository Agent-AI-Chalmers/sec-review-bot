import { getGitHubAppMetadata } from './github-app-metadata-service.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildMentionCandidates(): string[] {
  const metadata = getGitHubAppMetadata()
  const slug =
    typeof metadata.slug === 'string' && metadata.slug.trim() !== ''
      ? metadata.slug.trim().toLowerCase()
      : null
  const bot_login =
    typeof metadata.bot_login === 'string' && metadata.bot_login.trim() !== ''
      ? metadata.bot_login.trim().toLowerCase()
      : null

  return [slug, bot_login, slug ? `${slug}-bot` : null, slug ? `${slug}-bot[bot]` : null].filter(
    (item): item is string => Boolean(item)
  )
}

function stripMarkdownQuotedLines(body: string): string {
  // GitHub quote replies copy the original comment as Markdown blockquotes.
  // Commands inside those quoted lines are historical text, not a new request.
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
}

export function extractCommentCommand(body: unknown): {
  command: 'review'
  mention: string
  repair_mode: 'test-changes-allowed' | 'no-test-changes' | null
} | null {
  if (typeof body !== 'string' || body.trim() === '') {
    return null
  }

  const normalizedBody = stripMarkdownQuotedLines(body).trim().toLowerCase()

  if (normalizedBody === '') {
    return null
  }

  for (const candidate of buildMentionCandidates()) {
    const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(candidate)}(?:[,:]|\\s|$)`, 'i')
    const match = normalizedBody.match(pattern)

    if (!match) {
      continue
    }

    const startIndex = (match.index ?? 0) + match[0].length
    const commandText = normalizedBody.slice(startIndex).trim()
    const tokens = commandText.split(/\s+/)
    const command = tokens[0] ?? ''
    const repairModeToken = tokens[1] ?? ''
    const repair_mode = repairModeToken === 'no-test-changes' ? 'no-test-changes' : null

    if (command !== 'review') {
      continue
    }

    // A trigger comment is `@<bot> review`, optionally followed by `no-test-changes`. The
    // review objective is not part of the command: the GitHub integration always reviews an
    // issue in `audit` mode, because the issue is an unverified claim. (`repair` — proceeding
    // as though the report were already confirmed — is reserved for callers that supply a
    // trusted input, such as the PatchEval harness; it is not reachable from a comment.)
    const expectedTokenCount = repair_mode === null ? 1 : 2
    if (tokens.length !== expectedTokenCount) {
      return null
    }

    return {
      command: 'review',
      mention: candidate,
      repair_mode
    }
  }

  return null
}
