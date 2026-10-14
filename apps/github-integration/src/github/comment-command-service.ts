import type { TestChangesPolicy } from '../runner/input.js'
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

/** The default when no `--test-changes` flag is present, taken from the runner input contract. */
const DEFAULT_TEST_CHANGES: TestChangesPolicy = 'allow'

/** Parse flags after the command: `--test-changes <allow|deny>` takes a value, `--open-pr` is a
 * bare flag. Unknown flags or a missing/invalid `--test-changes` value fail the whole command, so
 * a typo is not silently ignored. Flags are order-independent. */
function parseOptions(tokens: string[]): {
  test_changes: TestChangesPolicy
  open_pr: boolean
} | null {
  let test_changes: TestChangesPolicy = DEFAULT_TEST_CHANGES
  let open_pr = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--open-pr') {
      open_pr = true
      continue
    }
    if (token === '--test-changes') {
      const value = tokens[index + 1]
      if (value !== 'allow' && value !== 'deny') {
        return null
      }
      test_changes = value
      index += 1
      continue
    }
    return null
  }
  return { test_changes, open_pr }
}

export function extractCommentCommand(body: unknown): {
  command: 'review'
  mention: string
  test_changes: TestChangesPolicy
  open_pr: boolean
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

    if (command !== 'review') {
      continue
    }

    // A trigger comment is `@<bot> review`, optionally followed by
    // `--test-changes <allow|deny>` and/or the bare `--open-pr` flag. The review objective is not part of the command: the
    // GitHub integration always reviews in `audit` mode, because the input is an unverified
    // claim. (`repair` — proceeding as though the report were already confirmed — is reserved
    // for callers that supply a trusted input, such as the PatchEval harness; it is not
    // reachable from a comment.)
    const options = parseOptions(tokens.slice(1))
    if (options === null) {
      return null
    }

    return {
      command: 'review',
      mention: candidate,
      test_changes: options.test_changes,
      open_pr: options.open_pr
    }
  }

  return null
}
