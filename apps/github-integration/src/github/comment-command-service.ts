import type { TestChangesPolicy } from '../execution/input.js'
import {
  currentAppBotLogin,
  getGitHubAppMetadata
} from './github-app-metadata-service.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The forms a user may type to address this app in a command comment.
 *
 * Two spellings are real: the bare slug (`@my-app`) and the bot login GitHub actually assigns
 * (`@my-app[bot]`). We deliberately do not guess variants such as `my-app-bot`: an invented
 * spelling either matches nothing (the reader's command is silently ignored) or, worse, matches
 * a different account whose name happens to end in `-bot`. `currentAppBotLogin` is the shared
 * source for the bot login so this cannot drift from the attribution checks. */
function buildMentionCandidates(): string[] {
  const metadata = getGitHubAppMetadata()
  const slug =
    typeof metadata.slug === 'string' && metadata.slug.trim() !== ''
      ? metadata.slug.trim().toLowerCase()
      : null
  const bot_login = currentAppBotLogin()
  return [slug, bot_login].filter((item): item is string => Boolean(item))
}

function stripMarkdownQuotedLines(body: string): string {
  // GitHub quote replies copy the original comment as Markdown blockquotes.
  // Commands inside those quoted lines are historical text, not a new request.
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
}

/** The default when no `--test-changes` flag is present, taken from the execution input contract. */
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

/** The mention spellings this app answers, for diagnostics. Empty when the app metadata is not
 * loaded, in which case no mention can be recognised. */
export function recognizedMentions(): string[] {
  return buildMentionCandidates()
}

/** Any `@handle` token a comment carries, whether or not it resolves to a command.
 *
 * The left boundary accepts punctuation, not only whitespace, because the spellings readers
 * actually type wrap the mention in markdown: `**@bot-bot**`, `__@bot-bot__`, `(@bot-bot)`,
 * `` `@bot-bot` ``, `_@bot-bot_`. Requiring whitespace would silently ignore all of them, which
 * is the opposite of what a diagnostic is for.
 *
 * An `@` can still be part of an address rather than a mention, so a preceding letter, digit,
 * `@`, or `/` is excluded… except that underscore is also markdown emphasis (`__@bot__`). The
 * underscore case cannot be decided from the left neighbour alone: `x_@bot` is a mention and
 * `name_@example.com` is an address. It is therefore decided by the token's own shape — see
 * `MAIL_DOMAIN` below — rather than by counting punctuation characters.
 *
 * Trailing `_`/`.`/`,`/`:` are stripped because they belong to the surrounding markdown or
 * sentence, not to the login. */
const MENTION_PATTERN = /(?<![a-z0-9@/])@([a-z0-9][a-z0-9[\]_\-.]*)/gi

/** What follows an `@` when it is glued to a word and is therefore an address, not a mention.
 *
 * A mail domain needs at least one dot and a TLD (`example.com`, `bar.co.uk`); a GitHub login
 * does not (`sec-review-bot-bot`). Using that difference is what lets `x_@bot` and `__@bot__`
 * through while keeping `name_@example.com` out, without enumerating which punctuation may
 * precede a mention. */
const MAIL_DOMAIN = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,}$/

/** Every `@…` mention a comment carries, in order, that is not one of the spellings this app
 * answers.
 *
 * The accepted spellings are narrow (`@<slug>` and `@<slug>[bot]`, see `buildMentionCandidates`),
 * so a comment addressing the app as `@<slug>-bot review` does nothing. Silently ignoring it
 * makes that look like the app is broken. The caller logs these mentions so an unmatched command
 * is diagnosable instead of invisible, while the parser itself stays a pure function. */
export function unmatchedMentions(body: unknown): string[] {
  if (typeof body !== 'string' || body.trim() === '') return []
  const normalizedBody = stripMarkdownQuotedLines(body).trim().toLowerCase()
  if (normalizedBody === '') return []
  const candidates = buildMentionCandidates()
  const mentions: string[] = []
  for (const match of normalizedBody.matchAll(MENTION_PATTERN)) {
    const start = match.index ?? 0
    const login = (match[1] ?? '').replace(/[,:.]+$/, '').replace(/_+$/, '')
    // An `@` glued to a word is an address only when the token itself is a mail domain. This is
    // what distinguishes `name_@example.com` from the markdown-wrapped `__@bot__` and from a
    // word ending in `_` followed by a mention.
    const gluedToWord =
      start > 0 && /[a-z0-9_]/.test(normalizedBody[start - 1] ?? '')
    if (gluedToWord && MAIL_DOMAIN.test(login)) continue
    if (login !== '' && !candidates.includes(login)) mentions.push(login)
  }
  return mentions
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
    const pattern = new RegExp(
      `(?:^|\\s)@${escapeRegExp(candidate)}(?:[,:]|\\s|$)`,
      'i'
    )
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
