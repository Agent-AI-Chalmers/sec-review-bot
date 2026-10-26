import React from 'react'
import {
  ActionIcon,
  Alert,
  Group,
  Modal,
  SegmentedControl,
  Text,
  Tooltip
} from '@mantine/core'
import { IconExternalLink } from '@tabler/icons-react'

import {
  api,
  isAbortError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { DiffEditor } from '../workspace/DiffEditor.js'
import { FileWorkspace } from '../workspace/FileWorkspace.js'
import {
  type Language,
  type Message,
  useLanguage,
  useMessages
} from '../../shared/i18n.js'
import type { components } from './api-types.generated.js'

type ChangeKind = 'added' | 'modified' | 'deleted'

type RevisionRecord = components['schemas']['MemoryTreeRevision']

function revisionDiffTitleParts(
  revision: number,
  predecessorRevision: number | null,
  language: Language,
  t: (key: Message) => string
): string[] {
  const revisionLabel = t('revisionReference').replace(
    '{revision}',
    String(revision)
  )
  const predecessorLabel =
    predecessorRevision === null
      ? t('emptyWorkspace')
      : t('revisionReference').replace(
          '{revision}',
          String(predecessorRevision)
        )
  return language === 'zh'
    ? [revisionLabel, t('diffWith'), predecessorLabel, t('diffCompare')]
    : [t('diffCompare'), revisionLabel, t('diffWith'), predecessorLabel]
}

export function MemoryRevisionDiffTitle({
  revision,
  predecessorRevision
}: {
  revision: number
  predecessorRevision: number | null
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const parts = revisionDiffTitleParts(
    revision,
    predecessorRevision,
    language,
    t
  )
  return (
    <span className="memory-diff-title" aria-label={parts.join(' ')}>
      {parts.map((part, index) => (
        <span key={`${index}-${part}`} aria-hidden="true">
          {part}
        </span>
      ))}
    </span>
  )
}

function languageFor(path: string): 'markdown' | 'json' | 'text' {
  if (path.endsWith('.md')) return 'markdown'
  if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'json'
  return 'text'
}

function changedFiles(
  before: Record<string, string>,
  after: Record<string, string>
): Map<string, ChangeKind> {
  const result = new Map<string, ChangeKind>()
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!Object.hasOwn(before, path)) result.set(path, 'added')
    else if (!Object.hasOwn(after, path)) result.set(path, 'deleted')
    else if (before[path] !== after[path]) result.set(path, 'modified')
  }
  return result
}

export function MemoryRevisionDiffContent({
  revision,
  predecessorRevision,
  fullPage = false
}: {
  revision: number
  predecessorRevision: number | null
  fullPage?: boolean
}): React.JSX.Element {
  const t = useMessages()
  const [before, setBefore] = React.useState<Record<string, string>>({})
  const [after, setAfter] = React.useState<Record<string, string>>({})
  const [selectedFile, setSelectedFile] = React.useState('')
  const [mode, setMode] = React.useState<'side-by-side' | 'unified'>(
    'side-by-side'
  )
  const [error, setError] = React.useState<unknown>()

  React.useEffect(() => {
    const controller = new AbortController()
    setBefore({})
    setAfter({})
    setSelectedFile('')
    setError(undefined)
    // Revision numbers are allocation order, not ancestry. Always fetch the predecessor recorded
    // on the revision so a branch created after a restore compares against its actual parent.
    const previous =
      predecessorRevision === null
        ? Promise.resolve({ files: {} as Record<string, string> })
        : api<{ files: Record<string, string> }>(
            `/memory/revisions/${predecessorRevision}/content`,
            { signal: controller.signal }
          )
    void Promise.all([
      previous,
      api<{ files: Record<string, string> }>(
        `/memory/revisions/${revision}/content`,
        { signal: controller.signal }
      )
    ])
      .then(([previousBody, currentBody]) => {
        if (controller.signal.aborted) return
        setBefore(previousBody.files)
        setAfter(currentBody.files)
        const changes = changedFiles(previousBody.files, currentBody.files)
        setSelectedFile(
          changes.has('MEMORY.md')
            ? 'MEMORY.md'
            : ([...changes.keys()].sort()[0] ?? '')
        )
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !isAbortError(failure))
          setError(failure)
      })
    return (): void => controller.abort()
  }, [predecessorRevision, revision, t])

  throwIfUnauthorized(error)

  const changes = React.useMemo(
    () => changedFiles(before, after),
    [after, before]
  )
  // Deleted files must remain selectable even though they no longer exist in the new archive.
  const files = React.useMemo(
    () =>
      Object.fromEntries(
        [...changes.keys()].map((path) => [path, after[path] ?? ''])
      ),
    [after, changes]
  )
  const markers = React.useMemo(
    () =>
      Object.fromEntries(
        [...changes].map(([path, kind]) => [
          path,
          {
            label: t(
              kind === 'added'
                ? 'diffAdded'
                : kind === 'deleted'
                  ? 'diffDeleted'
                  : 'diffModified'
            ),
            color:
              kind === 'added' ? 'green' : kind === 'deleted' ? 'red' : 'yellow'
          }
        ])
      ),
    [changes, t]
  )
  const predecessorLabel =
    predecessorRevision === null
      ? t('emptyWorkspace')
      : t('revisionReference').replace(
          '{revision}',
          String(predecessorRevision)
        )
  const revisionLabel = t('revisionReference').replace(
    '{revision}',
    String(revision)
  )

  if (error !== undefined)
    return (
      <div className="memory-diff-state">
        <Alert color="red">{t('memoryDiffLoadFailed')}</Alert>
      </div>
    )
  if (Object.keys(after).length === 0)
    return (
      <div className="memory-diff-state">
        <Text>{t('loading')}</Text>
      </div>
    )
  if (changes.size === 0)
    return (
      <div className="memory-diff-state">
        <Alert color="gray">{t('memoryDiffEmpty')}</Alert>
      </div>
    )

  return (
    <FileWorkspace
      files={files}
      selectedFile={selectedFile}
      onSelectFile={setSelectedFile}
      fileMarkers={markers}
      className="memory-diff-workspace"
      toolbar={
        <Group gap="sm" wrap="nowrap">
          <SegmentedControl
            value={mode}
            onChange={(value) => setMode(value as 'side-by-side' | 'unified')}
            data={[
              { label: t('diffSideBySide'), value: 'side-by-side' },
              { label: t('diffUnified'), value: 'unified' }
            ]}
          />
          {!fullPage && (
            <Tooltip label={t('openFullPage')}>
              <ActionIcon
                component="a"
                href={`/memory/revisions/${revision}/diff`}
                target="_blank"
                rel="noreferrer"
                variant="default"
                size="lg"
                aria-label={t('openFullPage')}
              >
                <IconExternalLink size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      }
      content={
        selectedFile ? (
          <DiffEditor
            key={`${selectedFile}-${mode}`}
            before={before[selectedFile] ?? ''}
            after={after[selectedFile] ?? ''}
            mode={mode}
            language={languageFor(selectedFile)}
            beforeLabel={`${predecessorLabel} · ${selectedFile}`}
            afterLabel={`${revisionLabel} · ${selectedFile}`}
          />
        ) : null
      }
    />
  )
}

export function MemoryRevisionDiffViewer({
  target,
  onClose
}: {
  target: RevisionRecord | undefined
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      opened={target !== undefined}
      onClose={onClose}
      title={
        target ? (
          <MemoryRevisionDiffTitle
            revision={target.revision}
            predecessorRevision={target.predecessor_revision}
          />
        ) : null
      }
      size="calc(100vw - 64px)"
      classNames={{ body: 'file-workspace-modal' }}
    >
      {target && (
        <MemoryRevisionDiffContent
          revision={target.revision}
          predecessorRevision={target.predecessor_revision}
        />
      )}
    </Modal>
  )
}

export async function loadRevisionRecord(
  revision: number,
  signal?: AbortSignal
): Promise<RevisionRecord> {
  return api<RevisionRecord>(`/memory/revisions/${revision}`, { signal })
}
