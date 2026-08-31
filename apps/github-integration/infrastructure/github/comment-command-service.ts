import { getGitHubAppMetadata } from './github-app-metadata-service.js'

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildMentionCandidates (): string[] {
  const metadata = getGitHubAppMetadata()
  const slug = typeof metadata.slug === 'string' && metadata.slug.trim() !== ''
    ? metadata.slug.trim().toLowerCase()
    : null
  const bot_login = typeof metadata.bot_login === 'string' && metadata.bot_login.trim() !== ''
    ? metadata.bot_login.trim().toLowerCase()
    : null

  return [
    slug,
    bot_login,
    slug ? `${slug}-bot` : null,
    slug ? `${slug}-bot[bot]` : null
  ].filter((item): item is string => Boolean(item))
}

function stripMarkdownQuotedLines (body: string): string {
  // GitHub quote replies copy the original comment as Markdown blockquotes.
  // Commands inside those quoted lines are historical text, not a new request.
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
}

export function extractCommentCommand (body: unknown): {
  command: 'review'
  mention: string
  issue_review_objective: 'audit' | 'repair' | null
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
    const issueReviewObjectiveToken = tokens[1] ?? ''
    const issueRepairModeToken = tokens[2] ?? ''
    const plainReviewRepairModeToken = tokens[1] ?? ''
    const issue_review_objective = issueReviewObjectiveToken === 'audit' || issueReviewObjectiveToken === 'repair'
      ? issueReviewObjectiveToken
      : null
    const repair_mode = (
      (issue_review_objective === 'repair' && issueRepairModeToken === 'no-test-changes') ||
      (issue_review_objective === null && plainReviewRepairModeToken === 'no-test-changes')
    )
      ? 'no-test-changes'
      : null

    if (command !== 'review') {
      continue
    }

    const expectedTokenCount = issue_review_objective === null
      ? (repair_mode === null ? 1 : 2)
      : (repair_mode === null ? 2 : 3)
    if (tokens.length !== expectedTokenCount) {
      return null
    }

    if (issueReviewObjectiveToken !== '' && issue_review_objective === null && repair_mode === null) {
      return null
    }

    if (issue_review_objective !== 'repair' && issueRepairModeToken !== '') {
      return null
    }

    return {
      command: 'review',
      mention: candidate,
      issue_review_objective,
      repair_mode
    }
  }

  return null
}
