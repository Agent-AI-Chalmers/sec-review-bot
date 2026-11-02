/**
 * Supported patch inputs.
 *
 * 1. Unified diff: optional `Index:` header, `---`/`+++` file lines,
 *    `@@ -a,b +c,d @@` hunks, `/dev/null` for add/delete, and
 *    `\ No newline at end of file`. Git metadata lines are ignored.
 * 2. `*** Begin Patch`: Add/Delete/Update File, optional `*** Move to`, and
 *    one or more chunks. Every update chunk must start with `@@`; a bare
 *    `@@` (no context text) is valid. Codex and OpenCode reject update
 *    content that omits the `@@` marker entirely.
 *
 * Anything else, or any unaccounted content/line-count mismatch, is marked
 * invalid. Callers must then show the raw text instead of a partial diff.
 *
 * Standard unified diffs could be delegated to jsdiff/gitdiff-parser. Begin
 * Patch has no mature library, so one strict parser with a shared hunk model
 * is the smaller surface today.
 */

export type DiffRowKind = 'context' | 'add' | 'remove'

export interface DiffRow {
  kind: DiffRowKind
  text: string
}

export interface DiffHunk {
  header: string
  rows: DiffRow[]
}

export type DiffFileStatus = 'added' | 'deleted'

export interface DiffFile {
  /** The current path; for a move this is the destination. */
  path: string
  movedFrom?: string
  status?: DiffFileStatus
  hunks: DiffHunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '')
}

export interface ParsedPatch {
  files: DiffFile[]
  /** True when patch-like content was seen but could not be fully consumed. */
  invalid: boolean
}

/** Parse the two patch dialects this repository sees into files and hunks. */
export function parsePatch(text: string): ParsedPatch {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const files: DiffFile[] = []
  let currentFile: DiffFile | undefined
  let currentHunk: DiffHunk | undefined
  // Hunk content can start with the same prefix as a file header ("--- old"
  // is a removal of "-- old"). The line counts in @@ tell us when the hunk
  // ends, so headers are only recognised outside a counted hunk.
  let countedHunk = false
  let oldRemaining = 0
  let newRemaining = 0
  let pendingOldPath: string | undefined
  let pendingOldIsNull = false
  // A "---" line opens a header pair; a hunk may only start after its "+++".
  let awaitingNewHeader = false
  let dialect: 'unified' | 'begin' | undefined
  let invalid = false

  const ensureFile = (path: string): DiffFile => {
    const existing = files.find((file) => file.path === path)
    if (existing) return existing
    const created = { path, hunks: [] }
    files.push(created)
    return created
  }

  const addRow = (kind: DiffRowKind, value: string): void => {
    currentHunk?.rows.push({ kind, text: value })
  }

  for (const line of lines) {
    if (currentHunk && countedHunk && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith('\\')) continue
      if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        addRow('context', line.slice(1))
        oldRemaining -= 1
        newRemaining -= 1
        continue
      }
      if (line.startsWith('-') && oldRemaining > 0) {
        addRow('remove', line.slice(1))
        oldRemaining -= 1
        continue
      }
      if (line.startsWith('+') && newRemaining > 0) {
        addRow('add', line.slice(1))
        newRemaining -= 1
        continue
      }
      // A header or hunk starting before the advertised counts ran out means
      // the patch is damaged; render the raw text rather than a wrong diff.
      invalid = true
      break
    }

    // The Begin Patch dialect has no line counts; its body runs until the next
    // section marker. "---"/"+++" are content there, never file headers.
    if (currentHunk && !countedHunk) {
      if (
        line.startsWith('@@') ||
        line.startsWith('*** ') ||
        line.startsWith('Index: ')
      ) {
        currentHunk = undefined
      } else {
        if (line.startsWith('\\')) continue
        if (line.startsWith('+')) addRow('add', line.slice(1))
        else if (line.startsWith('-')) addRow('remove', line.slice(1))
        else if (line.startsWith(' ')) addRow('context', line.slice(1))
        else if (line !== '') {
          invalid = true
          break
        }
        continue
      }
    }

    // In a unified diff, a content line outside a hunk means the advertised
    // counts ended early. ""/"+++"/"---" stay valid as file headers.
    if (
      dialect === 'unified' &&
      (line.startsWith(' ') ||
        (line.startsWith('+') && !line.startsWith('+++ ')) ||
        (line.startsWith('-') && !line.startsWith('--- ')))
    ) {
      invalid = true
      break
    }

    if (line.startsWith('Index: ')) {
      currentFile = ensureFile(line.slice('Index: '.length).trim())
      currentHunk = undefined
      pendingOldPath = undefined
      pendingOldIsNull = false
      awaitingNewHeader = false
      dialect = 'unified'
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      currentFile = ensureFile(line.slice('*** Update File: '.length).trim())
      currentHunk = undefined
      pendingOldPath = undefined
      pendingOldIsNull = false
      awaitingNewHeader = false
      dialect = 'begin'
      continue
    }
    if (line.startsWith('*** Move to: ')) {
      if (currentFile) {
        const target = line.slice('*** Move to: '.length).trim()
        currentFile.movedFrom = currentFile.path
        currentFile.path = target
      }
      continue
    }
    if (line.startsWith('*** Add File: ')) {
      currentFile = ensureFile(line.slice('*** Add File: '.length).trim())
      currentFile.status = 'added'
      // The Begin Patch dialect has no @@ header for a whole-file add/delete.
      currentHunk = { header: '', rows: [] }
      currentFile.hunks.push(currentHunk)
      countedHunk = false
      pendingOldPath = undefined
      pendingOldIsNull = false
      awaitingNewHeader = false
      dialect = 'begin'
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      currentFile = ensureFile(line.slice('*** Delete File: '.length).trim())
      currentFile.status = 'deleted'
      currentHunk = { header: '', rows: [] }
      currentFile.hunks.push(currentHunk)
      countedHunk = false
      pendingOldPath = undefined
      pendingOldIsNull = false
      awaitingNewHeader = false
      dialect = 'begin'
      continue
    }
    if (line.startsWith('+++ ')) {
      if (!awaitingNewHeader) {
        invalid = true
        break
      }
      const path = line.slice(4).split('\t')[0].trim()
      if (path === '/dev/null') {
        // A deletion keeps the old-side path; otherwise it has no name.
        if (pendingOldPath) {
          currentFile = ensureFile(stripPrefix(pendingOldPath))
          currentFile.status = 'deleted'
        }
      } else {
        currentFile = ensureFile(stripPrefix(path))
        if (pendingOldIsNull) currentFile.status = 'added'
      }
      currentHunk = undefined
      pendingOldPath = undefined
      pendingOldIsNull = false
      awaitingNewHeader = false
      dialect = 'unified'
      continue
    }
    if (line.startsWith('--- ')) {
      if (awaitingNewHeader) {
        invalid = true
        break
      }
      const path = line.slice(4).split('\t')[0].trim()
      pendingOldPath = path === '/dev/null' ? undefined : path
      pendingOldIsNull = path === '/dev/null'
      awaitingNewHeader = true
      dialect = 'unified'
      continue
    }
    if (line.startsWith('*** ')) {
      dialect = 'begin'
      continue
    }

    const hunkHeader = HUNK_HEADER.exec(line)
    if (hunkHeader) {
      if (awaitingNewHeader || !currentFile) {
        invalid = true
        break
      }
      currentHunk = { header: line, rows: [] }
      currentFile.hunks.push(currentHunk)
      countedHunk = true
      oldRemaining = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2])
      newRemaining = hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4])
      continue
    }
    if (line.startsWith('@@')) {
      // Bare @@ belongs to the Begin Patch dialect; a unified diff without
      // line counts cannot be trusted.
      if (awaitingNewHeader || dialect !== 'begin' || !currentFile) {
        invalid = true
        break
      }
      currentHunk = { header: line, rows: [] }
      currentFile.hunks.push(currentHunk)
      countedHunk = false
      continue
    }

    // OpenCode's apply_patch requires every update chunk to start with "@@";
    // update content here means the patch is damaged, so fall back to raw text
    // instead of silently dropping lines.
    if (
      currentFile &&
      !currentHunk &&
      dialect === 'begin' &&
      line !== '' &&
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
    ) {
      invalid = true
      break
    }
  }
  if (countedHunk && (oldRemaining > 0 || newRemaining > 0)) invalid = true
  if (awaitingNewHeader) invalid = true
  if (invalid) return { files: [], invalid: true }
  return {
    files: files.filter(
      (file) =>
        file.hunks.some((hunk) => hunk.rows.length > 0) ||
        file.status !== undefined ||
        file.movedFrom !== undefined
    ),
    invalid: false
  }
}

/** Array-only projection for callers that only need the parsed files. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  return parsePatch(text).files
}
