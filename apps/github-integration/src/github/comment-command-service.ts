import type { RepairMode } from '../runner/input.js'
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

/** The values `--repair-mode` accepts, taken from the runner input contract. */
const REPAIR_MODES = [
  'test-changes-allowed',
  'no-test-changes'
] as const satisfies readonly RepairMode[]

/** Parse `--name` flags and `--k=v` options after the command. Unknown options fail the whole
 * command, so a typo is not silently ignored. Options are order-independent. */
function parseOptions(tokens: string[]): {
  repair_mode: RepairMode | null
  open_pr: boolean
} | null {
  let repair_mode: RepairMode | null = null
  let open_pr = false
  for (const token of tokens) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token)
    if (match === null) {
      return null
    }
    // The capture groups always exist because the regex matched.
    const name = match[1]!
    const value = match[2]
    if (name === 'repair-mode') {
      if (value === undefined || !(REPAIR_MODES as readonly string[]).includes(value)) {
        return null
      }
      repair_mode = value as RepairMode
    } else if (name === 'open-pr') {
      // A bare boolean flag: its presence opts in, a value is not accepted.
      if (value !== undefined) {
        return null
      }
      open_pr = true
    } else {
      return null
    }
  }
  return { repair_mode, open_pr }
}

export function extractCommentCommand(body: unknown): {
  command: 'review'
  mention: string
  repair_mode: RepairMode | null
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

    // A trigger comment is `@<bot> review`, optionally followed by `--repair-mode=<value>`
    // and/or the bare `--open-pr` flag. The review objective is not part of the command: the
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
      repair_mode: options.repair_mode,
      open_pr: options.open_pr
    }
  }

  return null
}
