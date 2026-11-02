import React from 'react'
import { Badge, Group, SegmentedControl, Text } from '@mantine/core'
import { IconFileCode } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import { HighlightText } from './TrajectoryText.js'
import {
  parsePatch,
  type DiffFile,
  type DiffRow,
  type DiffRowKind
} from './diff-parse.js'

function patchLineKind(line: string): string {
  if (line.startsWith('*** ')) return 'file'
  if (
    line.startsWith('Index: ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  )
    return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

/** Raw fallback when a patch cannot be parsed into hunks. */
export function PatchView({
  text,
  query
}: {
  text: string
  query: string
}): React.JSX.Element {
  return (
    <div className="trajectory-patch" data-trajectory-patch="">
      {text.split('\n').map((line, index) => {
        const kind = patchLineKind(line)
        return (
          <div
            key={index}
            className={'trajectory-patch-line ' + kind}
            data-patch-line={kind}
          >
            <HighlightText value={line === '' ? ' ' : line} query={query} />
          </div>
        )
      })}
    </div>
  )
}

function UnifiedHunks({
  file,
  query
}: {
  file: DiffFile
  query: string
}): React.JSX.Element {
  return (
    <div className="trajectory-patch" data-trajectory-patch="">
      {file.hunks.map((hunk, hunkIndex) => (
        <React.Fragment key={hunkIndex}>
          {hunk.header !== '' && (
            <div className="trajectory-patch-line hunk" data-patch-line="hunk">
              <HighlightText value={hunk.header} query={query} />
            </div>
          )}
          {hunk.rows.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className={'trajectory-patch-line ' + row.kind}
              data-patch-line={row.kind}
            >
              <HighlightText
                value={
                  (row.kind === 'add'
                    ? '+'
                    : row.kind === 'remove'
                      ? '-'
                      : ' ') + row.text
                }
                query={query}
              />
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}

interface SplitRow {
  kind: DiffRowKind
  oldText: string | null
  newText: string | null
  oldChanged: boolean
  newChanged: boolean
}

/** Pair removals with additions so both columns describe the same region. */
function splitRows(rows: DiffRow[]): SplitRow[] {
  const split: SplitRow[] = []
  const pendingRemovals: DiffRow[] = []
  for (const row of rows) {
    if (row.kind === 'remove') {
      pendingRemovals.push(row)
      continue
    }
    if (row.kind === 'add') {
      const removal = pendingRemovals.shift()
      if (removal) {
        split.push({
          kind: 'add',
          oldText: removal.text,
          newText: row.text,
          oldChanged: true,
          newChanged: true
        })
      } else {
        split.push({
          kind: 'add',
          oldText: null,
          newText: row.text,
          oldChanged: false,
          newChanged: true
        })
      }
      continue
    }
    while (pendingRemovals.length > 0) {
      const removal = pendingRemovals.shift()
      if (removal)
        split.push({
          kind: 'remove',
          oldText: removal.text,
          newText: null,
          oldChanged: true,
          newChanged: false
        })
    }
    split.push({
      kind: 'context',
      oldText: row.text,
      newText: row.text,
      oldChanged: false,
      newChanged: false
    })
  }
  while (pendingRemovals.length > 0) {
    const removal = pendingRemovals.shift()
    if (removal)
      split.push({
        kind: 'remove',
        oldText: removal.text,
        newText: null,
        oldChanged: true,
        newChanged: false
      })
  }
  return split
}

function SplitHunks({
  file,
  query
}: {
  file: DiffFile
  query: string
}): React.JSX.Element {
  return (
    <div className="trajectory-diff-split">
      {file.hunks.map((hunk, hunkIndex) => (
        <React.Fragment key={hunkIndex}>
          {hunk.header !== '' && (
            <div className="trajectory-diff-split-header">
              <HighlightText value={hunk.header} query={query} />
            </div>
          )}
          {splitRows(hunk.rows).map((row, rowIndex) => (
            <div
              key={rowIndex}
              className={'trajectory-diff-split-row ' + row.kind}
              data-diff-kind={row.kind}
            >
              <div
                className={
                  'trajectory-diff-cell old' +
                  (row.oldChanged ? ' changed' : '')
                }
              >
                {row.oldText !== null && (
                  <HighlightText value={row.oldText} query={query} />
                )}
              </div>
              <div
                className={
                  'trajectory-diff-cell new' +
                  (row.newChanged ? ' changed' : '')
                }
              >
                {row.newText !== null && (
                  <HighlightText value={row.newText} query={query} />
                )}
              </div>
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}

function fileStats(file: DiffFile): { adds: number; removes: number } {
  let adds = 0
  let removes = 0
  for (const hunk of file.hunks) {
    for (const row of hunk.rows) {
      if (row.kind === 'add') adds += 1
      else if (row.kind === 'remove') removes += 1
    }
  }
  return { adds, removes }
}

function displayPath(path: string): string {
  // Container workdirs are noise in a narrow card; keep the repo-relative tail.
  return path.replace(/^\/workspace\//, '')
}

export function DiffView({
  text,
  query,
  truncated = false
}: {
  text: string
  query: string
  truncated?: boolean
}): React.JSX.Element {
  const t = useMessages()
  const [mode, setMode] = React.useState<'unified' | 'side-by-side'>('unified')
  const parsed = React.useMemo(() => parsePatch(text), [text])
  const files = parsed.files
  if (files.length === 0)
    return (
      <div className="trajectory-diff-view">
        {truncated && (
          <Text size="xs" c="orange.7" className="trajectory-diff-truncated">
            {t('trajectoryDiffTruncated')}
          </Text>
        )}
        <Text size="xs" c="dimmed" className="trajectory-diff-fallback">
          {t('trajectoryDiffFallback')}
        </Text>
        <PatchView text={text} query={query} />
      </div>
    )
  const toggle = (
    <SegmentedControl
      size="xs"
      value={mode}
      onChange={(value) => setMode(value as 'unified' | 'side-by-side')}
      data={[
        { label: t('diffUnified'), value: 'unified' },
        { label: t('diffSideBySide'), value: 'side-by-side' }
      ]}
    />
  )
  return (
    <div className="trajectory-diff-view" data-diff-mode={mode}>
      {truncated && (
        <Text size="xs" c="orange.7" className="trajectory-diff-truncated">
          {t('trajectoryDiffTruncated')}
        </Text>
      )}
      {files.length > 1 && (
        <Group justify="flex-end" mb={4}>
          {toggle}
        </Group>
      )}
      {files.map((file) => {
        const stats = fileStats(file)
        const pathLabel = file.movedFrom
          ? displayPath(file.movedFrom) + ' → ' + displayPath(file.path)
          : displayPath(file.path)
        const title = file.movedFrom
          ? file.movedFrom + ' → ' + file.path
          : file.path
        return (
          <div className="trajectory-diff-file" key={file.path}>
            <div className="trajectory-diff-file-header" title={title}>
              <IconFileCode size={ICON_SIZE.sm} />
              <Text
                size="sm"
                fw={600}
                truncate
                className="trajectory-diff-file-path"
              >
                <HighlightText value={pathLabel} query={query} />
              </Text>
              {file.movedFrom ? (
                <Badge size="xs" variant="light" color="blue">
                  {t('diffFileMoved')}
                </Badge>
              ) : file.status === 'added' ? (
                <Badge size="xs" variant="light" color="green">
                  {t('diffFileAdded')}
                </Badge>
              ) : file.status === 'deleted' ? (
                <Badge size="xs" variant="light" color="red">
                  {t('diffFileDeleted')}
                </Badge>
              ) : null}
              {(stats.adds > 0 || stats.removes > 0) && (
                <Text
                  size="xs"
                  c="dimmed"
                  className="trajectory-diff-file-stats"
                >
                  {'+' + stats.adds} {'−' + stats.removes}
                </Text>
              )}
              {files.length === 1 && toggle}
            </div>
            {mode === 'unified' ? (
              <UnifiedHunks file={file} query={query} />
            ) : (
              <SplitHunks file={file} query={query} />
            )}
          </div>
        )
      })}
    </div>
  )
}
