import React from 'react'
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core'
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'

import { useWorkspaceSidebar } from './useWorkspaceSidebar.js'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'
import { formatBytes } from '../../shared/format.js'
import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'

const CodeEditor = React.lazy(async () => ({
  default: (await import('./CodeEditor.js')).CodeEditor
}))
const JsonFilePreview = React.lazy(async () => ({
  default: (await import('./JsonFilePreview.js')).JsonFilePreview
}))
const MarkdownPreview = React.lazy(async () => ({
  default: (await import('./MarkdownPreview.js')).MarkdownPreview
}))

function validFilePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.endsWith('/')) return false
  const parts = path.split('/')
  return parts.every(
    (part) =>
      part !== '' && part !== '.' && part !== '..' && !part.includes('\\')
  )
}

function linkedFile(
  files: Record<string, string>,
  selectedFile: string,
  href: string | undefined
): string | undefined {
  if (!href || /^(?:[a-z]+:|#)/i.test(href)) return undefined
  const withoutQuery = decodeURIComponent(href).split(/[?#]/, 1)[0] ?? ''
  const candidate = withoutQuery.replace(/^\.\//, '').replace(/^\//, '')
  const directory = selectedFile.includes('/')
    ? selectedFile.slice(0, selectedFile.lastIndexOf('/') + 1)
    : ''
  const parts = `${directory}${candidate}`.split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  const target = normalized.join('/')
  return Object.hasOwn(files, target) ? target : undefined
}

export function FileWorkspace({
  files,
  unpreviewableFiles = {},
  selectedFile,
  onSelectFile,
  editable = false,
  onFilesChange,
  modifiedFiles = new Set<string>(),
  fileMarkers = {},
  toolbar,
  content,
  className = ''
}: {
  files: Record<string, string>
  unpreviewableFiles?: Record<string, { sizeBytes: number }>
  selectedFile: string
  onSelectFile: (path: string) => void
  editable?: boolean
  onFilesChange?: (files: Record<string, string>) => void
  modifiedFiles?: ReadonlySet<string>
  fileMarkers?: Readonly<Record<string, { label: string; color: string }>>
  toolbar?: React.ReactNode
  content?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const t = useMessages()
  const [mode, setMode] = React.useState(editable ? 'edit' : 'preview')
  const [operation, setOperation] = React.useState<'new' | 'rename'>()
  const [pathInput, setPathInput] = React.useState('')
  const [pathError, setPathError] = React.useState('')
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const { workspaceRef, sidebarWidth, splitterProps } = useWorkspaceSidebar()
  const paths = React.useMemo(
    () => [
      ...new Set([...Object.keys(files), ...Object.keys(unpreviewableFiles)])
    ],
    [files, unpreviewableFiles]
  )
  const isMarkdown = selectedFile.endsWith('.md')
  const isJson = selectedFile.endsWith('.json')
  const isJsonLines = selectedFile.endsWith('.jsonl')
  const unpreviewable = unpreviewableFiles[selectedFile]

  React.useEffect(() => {
    if (!selectedFile) return
    if (unpreviewable) return
    if (!isMarkdown && !isJson && !isJsonLines && mode === 'preview')
      setMode(editable ? 'edit' : 'source')
  }, [
    editable,
    isJson,
    isJsonLines,
    isMarkdown,
    mode,
    selectedFile,
    unpreviewable
  ])

  const openOperation = (next: 'new' | 'rename'): void => {
    setOperation(next)
    setPathInput(next === 'rename' ? selectedFile : '')
    setPathError('')
  }
  const applyOperation = (): void => {
    if (!editable || !onFilesChange || !operation) return
    const nextPath = pathInput.trim()
    if (
      !validFilePath(nextPath) ||
      (nextPath !== selectedFile && Object.hasOwn(files, nextPath))
    ) {
      setPathError(t('workspaceInvalidFilename'))
      return
    }
    const nextFiles = { ...files }
    if (operation === 'new') nextFiles[nextPath] = ''
    else {
      nextFiles[nextPath] = nextFiles[selectedFile] ?? ''
      delete nextFiles[selectedFile]
    }
    onFilesChange(nextFiles)
    onSelectFile(nextPath)
    setMode('edit')
    setOperation(undefined)
  }
  const deleteSelected = (): void => {
    if (!onFilesChange || Object.keys(files).length <= 1) return
    const nextFiles = { ...files }
    delete nextFiles[selectedFile]
    const nextSelection = Object.keys(nextFiles).sort()[0] ?? ''
    onFilesChange(nextFiles)
    onSelectFile(nextSelection)
    setDeleteOpen(false)
  }
  const modeData = editable
    ? [
        { label: t('edit'), value: 'edit' },
        ...(isMarkdown ? [{ label: t('preview'), value: 'preview' }] : [])
      ]
    : unpreviewable
      ? []
      : [
          ...(isMarkdown || isJson || isJsonLines
            ? [{ label: t('preview'), value: 'preview' }]
            : []),
          { label: t('source'), value: 'source' }
        ]

  return (
    <>
      <div
        ref={workspaceRef}
        className={`file-workspace ${className}`.trim()}
        style={
          {
            '--file-workspace-sidebar-width': `${sidebarWidth}px`
          } as React.CSSProperties
        }
      >
        <div className="file-workspace-sidebar">
          {editable && (
            <Group justify="space-between" px="sm" pt="sm" wrap="nowrap">
              <Text fw={600} size="sm">
                {t('files')}
              </Text>
              <Group gap={2} wrap="nowrap">
                <Tooltip label={t('newFile')}>
                  <ActionIcon
                    variant="subtle"
                    aria-label={t('newFile')}
                    onClick={() => openOperation('new')}
                  >
                    <IconPlus size={ICON_SIZE.md} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('renameFile')}>
                  <ActionIcon
                    variant="subtle"
                    aria-label={t('renameFile')}
                    disabled={!selectedFile}
                    onClick={() => openOperation('rename')}
                  >
                    <IconPencil size={ICON_SIZE.md} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('deleteFile')}>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('deleteFile')}
                    disabled={Object.keys(files).length <= 1}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <IconTrash size={ICON_SIZE.md} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          )}
          <WorkspaceFileTree
            paths={paths}
            selectedFile={selectedFile}
            onSelect={onSelectFile}
            modifiedFiles={modifiedFiles}
            fileMarkers={fileMarkers}
          />
        </div>
        <div
          className="file-workspace-splitter"
          role="separator"
          aria-label={t('resizeFileTree')}
          aria-orientation="vertical"
          {...splitterProps}
        />
        <div className="file-workspace-content">
          <Group justify="space-between" mb="md" wrap="nowrap">
            <Text fw={600} truncate>
              {selectedFile}
            </Text>
            <Group gap="sm" wrap="nowrap">
              {content === undefined && modeData.length > 1 && (
                <SegmentedControl
                  value={mode}
                  onChange={setMode}
                  data={modeData}
                />
              )}
              {toolbar}
            </Group>
          </Group>
          {content !== undefined ? (
            content
          ) : unpreviewable ? (
            <Alert color="gray" title={t('previewUnavailable')}>
              {t('previewUnavailableDescription', {
                size: formatBytes(unpreviewable.sizeBytes)
              })}
            </Alert>
          ) : editable && mode === 'edit' ? (
            <React.Suspense fallback={null}>
              <CodeEditor
                key={selectedFile}
                value={files[selectedFile] ?? ''}
                ariaLabel={t('workspaceEditor')}
                language={isJson ? 'json' : isMarkdown ? 'markdown' : 'text'}
                onChange={(value) =>
                  onFilesChange?.({ ...files, [selectedFile]: value })
                }
              />
            </React.Suspense>
          ) : mode === 'preview' && isMarkdown ? (
            <div className="memory-markdown memory-markdown-full file-workspace-preview">
              <React.Suspense fallback={null}>
                <MarkdownPreview
                  source={files[selectedFile] ?? ''}
                  onOpenLink={(href) => {
                    const target = linkedFile(files, selectedFile, href)
                    if (target === undefined) return false
                    onSelectFile(target)
                    return true
                  }}
                />
              </React.Suspense>
            </div>
          ) : mode === 'preview' && (isJson || isJsonLines) ? (
            <div className="file-workspace-preview">
              <React.Suspense fallback={null}>
                <JsonFilePreview
                  content={files[selectedFile] ?? ''}
                  jsonLines={isJsonLines}
                />
              </React.Suspense>
            </div>
          ) : (
            <React.Suspense fallback={null}>
              <CodeEditor
                key={`${selectedFile}-source`}
                value={files[selectedFile] ?? ''}
                ariaLabel={t('workspaceSource')}
                language={
                  isJson || isJsonLines
                    ? 'json'
                    : isMarkdown
                      ? 'markdown'
                      : 'text'
                }
                readOnly
                onChange={() => undefined}
              />
            </React.Suspense>
          )}
        </div>
      </div>
      <Modal
        opened={operation !== undefined}
        onClose={() => setOperation(undefined)}
        title={operation === 'new' ? t('newFile') : t('renameFile')}
        centered
      >
        <TextInput
          autoFocus
          label={t('filePath')}
          value={pathInput}
          onChange={(event) => setPathInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyOperation()
          }}
        />
        {pathError && (
          <Alert color="red" mt="sm">
            {pathError}
          </Alert>
        )}
        <Group justify="end" mt="md">
          <Button variant="default" onClick={() => setOperation(undefined)}>
            {t('cancel')}
          </Button>
          <Button onClick={applyOperation}>{t('confirm')}</Button>
        </Group>
      </Modal>
      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('deleteFile')}
        centered
      >
        <Text>{t('deleteFileWarning', { file: selectedFile })}</Text>
        <Group justify="end" mt="md">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>
            {t('cancel')}
          </Button>
          <Button color="red" onClick={deleteSelected}>
            {t('delete')}
          </Button>
        </Group>
      </Modal>
    </>
  )
}
