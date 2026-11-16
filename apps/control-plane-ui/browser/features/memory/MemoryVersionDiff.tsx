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

import type { MemoryTreeContentResponse } from '../../../shared/artifact-content.js'
import {
  api,
  isAbortError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { DiffEditor } from '../workspace/DiffEditor.js'
import { FileWorkspace } from '../workspace/FileWorkspace.js'
import {
  type Language,
  type Translator,
  useLanguage,
  useMessages
} from '../../shared/i18n.js'
import type { MemoryTreeVersion } from './api-types.generated.js'
import { ICON_SIZE } from '../../shared/design.js'

type ChangeKind = 'added' | 'modified' | 'deleted'

type VersionRecord = MemoryTreeVersion

function versionDiffTitleParts(
  version: number,
  predecessorVersion: number | null,
  language: Language,
  t: Translator
): string[] {
  const versionLabel = t('versionReference', { version: String(version) })
  const predecessorLabel =
    predecessorVersion === null
      ? t('emptyWorkspace')
      : t('versionReference', { version: String(predecessorVersion) })
  return language === 'zh'
    ? [versionLabel, t('diffWith'), predecessorLabel, t('diffCompare')]
    : [t('diffCompare'), versionLabel, t('diffWith'), predecessorLabel]
}

export function MemoryVersionDiffTitle({
  version,
  predecessorVersion
}: {
  version: number
  predecessorVersion: number | null
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const parts = versionDiffTitleParts(version, predecessorVersion, language, t)
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

export function MemoryVersionDiffContent({
  version,
  predecessorVersion,
  fullPage = false
}: {
  version: number
  predecessorVersion: number | null
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
    // Version numbers are allocation order, not ancestry. Always fetch the predecessor recorded
    // on the version so a branch created after a restore compares against its actual parent.
    const previous =
      predecessorVersion === null
        ? Promise.resolve<MemoryTreeContentResponse>({ files: {} })
        : api<MemoryTreeContentResponse>(
            `/memory/versions/${predecessorVersion}/content`,
            { signal: controller.signal }
          )
    void Promise.all([
      previous,
      api<MemoryTreeContentResponse>(`/memory/versions/${version}/content`, {
        signal: controller.signal
      })
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
  }, [predecessorVersion, version, t])

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
    predecessorVersion === null
      ? t('emptyWorkspace')
      : t('versionReference', { version: String(predecessorVersion) })
  const versionLabel = t('versionReference', { version: String(version) })

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
                href={`/memory/versions/${version}/diff`}
                target="_blank"
                rel="noreferrer"
                variant="default"
                size="lg"
                aria-label={t('openFullPage')}
              >
                <IconExternalLink size={ICON_SIZE.lg} />
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
            afterLabel={`${versionLabel} · ${selectedFile}`}
          />
        ) : null
      }
    />
  )
}

export function MemoryVersionDiffViewer({
  target,
  onClose
}: {
  target: VersionRecord | undefined
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      opened={target !== undefined}
      onClose={onClose}
      title={
        target ? (
          <MemoryVersionDiffTitle
            version={target.version}
            predecessorVersion={target.predecessor_version}
          />
        ) : null
      }
      size="calc(100vw - 64px)"
      classNames={{ body: 'file-workspace-modal' }}
    >
      {target && (
        <MemoryVersionDiffContent
          version={target.version}
          predecessorVersion={target.predecessor_version}
        />
      )}
    </Modal>
  )
}

export async function loadVersionRecord(
  version: number,
  signal?: AbortSignal
): Promise<VersionRecord> {
  return api<VersionRecord>(`/memory/versions/${version}`, { signal })
}
