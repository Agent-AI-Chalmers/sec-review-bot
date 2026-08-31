import type { ReviewRecord } from '../review-record.js'

import { publishPullRequestSuggestionReview } from './suggestion-comments.js'
import type { PullRequestReviewEvent } from '../../infrastructure/github/comment-service.js'
import type { PullRequestContext } from '../../infrastructure/github/pull-request-service.js'

// This file is the pull-request suggestion pipeline.
// It owns local suggestion artifacts and the policy that decides whether a
// mitigation patch can be promoted into GitHub inline suggestions.
// Patch parsing and candidate shaping stay here, while the GitHub review
// comment publication adapter stays next to the suggestion pipeline.

interface HunkHeader {
  old_start: number
  old_count: number
  new_start: number
  new_count: number
}

interface WorkspaceHunk extends HunkHeader {
  lines: string[]
}

interface WorkspacePatchFile {
  path: string
  hunks: WorkspaceHunk[]
}

interface PullRequestFile {
  filename: string
  patch?: string | null
}

interface SuggestionCandidate {
  path: string
  side: 'RIGHT'
  start_line: number
  line: number
  replacement: string
  body: string
}

interface UnmappedSuggestionChange {
  path: string
  reason: string
  hunk?: {
    new_start: number
    new_count: number
  }
}

interface SuggestionManifest {
  generated_at: string
  strategy: 'multi-file-multi-hunk'
  candidates: SuggestionCandidate[]
  unmapped_changes: UnmappedSuggestionChange[]
  skipped_reason: string | null
}

interface SuggestionPublishedResult {
  published_at: string
  review_id: number
  html_url: string
  state: string
  count: number
  comments: Array<{
    path: string
    line: number
    start_line: number
  }>
}

interface WorkspaceSuggestionBlock {
  start_line: number
  line: number
  replacement: string
}

function parseHunkHeader (headerLine: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(headerLine)

  if (!match) {
    return null
  }

  return {
    old_start: Number(match[1]),
    old_count: Number(match[2] ?? '1'),
    new_start: Number(match[3]),
    new_count: Number(match[4] ?? '1')
  }
}

function parseWorkspacePatch (patch_content: string): WorkspacePatchFile[] {
  const lines = patch_content.split('\n')
  const files: WorkspacePatchFile[] = []
  let current_file: WorkspacePatchFile | null = null
  let current_hunk: WorkspaceHunk | null = null

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff -ruN ')) {
      const gitStyleMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      const runDiffStyleMatch = /^diff -ruN a\/(.+) b\/(.+)$/.exec(line)
      const match = gitStyleMatch ?? runDiffStyleMatch

      current_file = match
        ? {
            path: normalizeWorkspacePatchPath(match[2] ?? ''),
            hunks: []
          }
        : null

      current_hunk = null

      if (current_file) {
        files.push(current_file)
      }

      continue
    }

    if (!current_file) {
      continue
    }

    if (line.startsWith('@@ ')) {
      const header = parseHunkHeader(line)

      if (!header) {
        current_hunk = null
        continue
      }

      current_hunk = {
        ...header,
        lines: []
      }
      current_file.hunks.push(current_hunk)
      continue
    }

    if (current_hunk && /^[ +-]/.test(line)) {
      current_hunk.lines.push(line)
    }
  }

  return files
}

function normalizeWorkspacePatchPath (rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized.startsWith('workspace/')
    ? normalized.slice('workspace/'.length)
    : normalized
}

function parsePatchHunks (patch_content: string): HunkHeader[] {
  if (typeof patch_content !== 'string' || patch_content.trim() === '') {
    return []
  }

  return patch_content
    .split('\n')
    .filter((line) => line.startsWith('@@ '))
    .map((line) => parseHunkHeader(line))
    .filter((item): item is HunkHeader => item !== null)
}

function buildSuggestionBody (replacement: string): string {
  return [
    '```suggestion',
    replacement,
    '```'
  ].join('\n')
}

function toLineRange (start: number, count: number): { start: number, end: number } | null {
  if (start <= 0 || count <= 0) {
    return null
  }
  return {
    start,
    end: start + count - 1
  }
}

function rangesOverlap (
  left: { start: number, end: number },
  right: { start: number, end: number }
): boolean {
  return left.start <= right.end && right.start <= left.end
}

function findAnchoringHunkForBlock (block: WorkspaceSuggestionBlock, prHunks: HunkHeader[]): HunkHeader | null {
  const blockRange = toLineRange(block.start_line, block.line - block.start_line + 1)
  if (!blockRange) {
    return null
  }

  for (const prHunk of prHunks) {
    const prRange = toLineRange(prHunk.new_start, prHunk.new_count)
    if (!prRange) {
      continue
    }
    if (rangesOverlap(blockRange, prRange)) {
      return prHunk
    }
  }

  return null
}

function splitWorkspaceHunkIntoSuggestionBlocks (workspaceHunk: WorkspaceHunk): WorkspaceSuggestionBlock[] {
  const blocks: WorkspaceSuggestionBlock[] = []
  const lines = workspaceHunk.lines
  if (lines.length === 0) {
    return blocks
  }

  const old_line_at_index: number[] = []
  let oldLineCursor = workspaceHunk.old_start
  for (const line of lines) {
    old_line_at_index.push(oldLineCursor)
    const marker = line[0]
    if (marker === ' ' || marker === '-') {
      oldLineCursor += 1
    }
  }

  let index = 0
  while (index < lines.length) {
    const marker = lines[index]?.[0]
    if (marker !== '+' && marker !== '-') {
      index += 1
      continue
    }

    const runStart = index
    while (index < lines.length) {
      const runMarker = lines[index]?.[0]
      if (runMarker !== '+' && runMarker !== '-') {
        break
      }
      index += 1
    }
    const runEnd = index - 1

    const plus_lines: string[] = []
    const minus_line_numbers: number[] = []
    for (let i = runStart; i <= runEnd; i += 1) {
      const runLine = lines[i] ?? ''
      const runLineMarker = runLine[0]
      if (runLineMarker === '+') {
        plus_lines.push(runLine.slice(1))
      } else if (runLineMarker === '-') {
        minus_line_numbers.push(old_line_at_index[i] ?? 0)
      }
    }

    if (plus_lines.length === 0 && minus_line_numbers.length > 0) {
      const start_line = minus_line_numbers[0] ?? 0
      const line = minus_line_numbers[minus_line_numbers.length - 1] ?? 0
      if (start_line > 0 && line >= start_line) {
        blocks.push({
          start_line,
          line,
          replacement: ''
        })
      }
      continue
    }

    if (plus_lines.length === 0) {
      continue
    }

    const replacementCore = plus_lines.join('\n').trimEnd()
    if (!replacementCore) {
      continue
    }

    if (minus_line_numbers.length > 0) {
      const start_line = minus_line_numbers[0] ?? 0
      const line = minus_line_numbers[minus_line_numbers.length - 1] ?? 0
      if (start_line > 0 && line >= start_line) {
        blocks.push({
          start_line,
          line,
          replacement: replacementCore
        })
      }
      continue
    }

    const insertionLine = old_line_at_index[runStart] ?? 0
    if (insertionLine <= 0) {
      continue
    }

    let anchored_replacement: string | null = null
    for (let i = runEnd + 1; i < lines.length; i += 1) {
      const contextLine = lines[i] ?? ''
      if (contextLine[0] === ' ') {
        anchored_replacement = `${replacementCore}\n${contextLine.slice(1)}`
        break
      }
    }

    if (!anchored_replacement) {
      for (let i = runStart - 1; i >= 0; i -= 1) {
        const contextLine = lines[i] ?? ''
        if (contextLine[0] === ' ') {
          anchored_replacement = `${contextLine.slice(1)}\n${replacementCore}`
          break
        }
      }
    }

    if (!anchored_replacement) {
      continue
    }

    blocks.push({
      start_line: insertionLine,
      line: insertionLine,
      replacement: anchored_replacement
    })
  }

  return blocks
}

function buildSuggestionManifest ({
  patch_content,
  files,
  review_record
}: {
  patch_content: string
  files: PullRequestFile[]
  review_record: ReviewRecord | null | undefined
}): SuggestionManifest {
  const mitigation = review_record?.mitigation
  const workspacePatchFiles = parseWorkspacePatch(patch_content)
  const manifest: SuggestionManifest = {
    generated_at: new Date().toISOString(),
    strategy: 'multi-file-multi-hunk',
    candidates: [],
    unmapped_changes: [],
    skipped_reason: null
  }
  const skipReasons = new Set<string>()

  if (!mitigation || workspacePatchFiles.length === 0) {
    manifest.skipped_reason = 'Workspace patch contains no suggestible file entries.'
    return manifest
  }

  for (const workspacePatchFile of workspacePatchFiles) {
    const prFile = files.find((file) => file.filename === workspacePatchFile.path)
    if (!prFile || typeof prFile.patch !== 'string' || prFile.patch.trim() === '') {
      const reason = 'File is not visible as a patchable PR diff file.'
      skipReasons.add(`File ${workspacePatchFile.path} is not visible as a patchable PR diff file.`)
      manifest.unmapped_changes.push({
        path: workspacePatchFile.path,
        reason
      })
      continue
    }

    const prHunks = parsePatchHunks(prFile.patch)
    if (prHunks.length === 0) {
      const reason = 'File has no anchorable PR patch hunks.'
      skipReasons.add(`File ${workspacePatchFile.path} has no anchorable PR patch hunks.`)
      manifest.unmapped_changes.push({
        path: workspacePatchFile.path,
        reason
      })
      continue
    }

    for (const workspaceHunk of workspacePatchFile.hunks) {
      const suggestionBlocks = splitWorkspaceHunkIntoSuggestionBlocks(workspaceHunk)
      if (suggestionBlocks.length === 0) {
        const reason = 'Workspace hunk produced an empty suggestion replacement.'
        skipReasons.add(`File ${workspacePatchFile.path} produced an empty suggestion replacement.`)
        manifest.unmapped_changes.push({
          path: workspacePatchFile.path,
          reason,
          hunk: {
            new_start: workspaceHunk.new_start,
            new_count: workspaceHunk.new_count
          }
        })
        continue
      }

      for (const block of suggestionBlocks) {
        const anchoringHunk = findAnchoringHunkForBlock(block, prHunks)
        if (!anchoringHunk) {
          const reason = 'Workspace hunk has no overlapping PR hunk.'
          skipReasons.add(`File ${workspacePatchFile.path} has no overlapping PR hunk for a workspace hunk.`)
          manifest.unmapped_changes.push({
            path: workspacePatchFile.path,
            reason,
            hunk: {
              new_start: workspaceHunk.new_start,
              new_count: workspaceHunk.new_count
            }
          })
          continue
        }

        const anchoringRange = toLineRange(anchoringHunk.new_start, anchoringHunk.new_count)
        if (!anchoringRange) {
          const reason = 'Workspace hunk has no right-side line range for inline suggestion anchoring.'
          skipReasons.add(`File ${workspacePatchFile.path} has no right-side line range for inline suggestion anchoring.`)
          manifest.unmapped_changes.push({
            path: workspacePatchFile.path,
            reason,
            hunk: {
              new_start: workspaceHunk.new_start,
              new_count: workspaceHunk.new_count
            }
          })
          continue
        }

        const start_line = Math.max(block.start_line, anchoringRange.start)
        const line = Math.min(block.line, anchoringRange.end)
        if (start_line > line) {
          continue
        }

        manifest.candidates.push({
          path: workspacePatchFile.path,
          side: 'RIGHT',
          start_line,
          line,
          replacement: block.replacement,
          body: buildSuggestionBody(block.replacement)
        })
      }
    }
  }

  if (manifest.candidates.length === 0) {
    manifest.skipped_reason = skipReasons.size > 0
      ? Array.from(skipReasons)[0] ?? 'No eligible patch candidate.'
      : 'No eligible patch candidate.'
  }

  return manifest
}

export async function generateSuggestionCandidatesFromReviewRecord ({
  files,
  review_record
}: {
  files: PullRequestFile[]
  review_record: ReviewRecord | null | undefined
}): Promise<SuggestionManifest> {
  const patch_content = typeof review_record?.mitigation?.patch_diff === 'string'
    ? review_record.mitigation.patch_diff
    : ''
  if (patch_content.trim() === '') {
    throw new Error('Pull request suggestion generation requires review_record.mitigation.patch_diff.')
  }
  const manifest = buildSuggestionManifest({
    patch_content,
    files,
    review_record
  })

  return manifest
}

export async function publishSuggestionReview (
  octokit: unknown,
  {
    pr,
    review_body,
    event,
    candidates
  }: {
    pr: PullRequestContext
    review_body: string
    event: PullRequestReviewEvent
    candidates: SuggestionCandidate[]
  }
): Promise<SuggestionPublishedResult> {
  const published: SuggestionPublishedResult = {
    published_at: new Date().toISOString(),
    ...(await publishPullRequestSuggestionReview(octokit as Parameters<typeof publishPullRequestSuggestionReview>[0], {
      pr,
      review_body,
      event,
      candidates
    }))
  }

  return published
}
