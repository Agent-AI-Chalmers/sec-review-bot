import React from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Collapse,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFileText,
  IconFolder,
  IconPencil,
  IconPlus,
  IconTrash
} from '@tabler/icons-react'

import { formatBytes } from '../../shared/format.js'
import { useMessages } from '../../shared/i18n.js'

const CodeEditor = React.lazy(async () => ({
  default: (await import('./CodeEditor.js')).CodeEditor
}))
const JsonFilePreview = React.lazy(async () => ({
  default: (await import('./JsonFilePreview.js')).JsonFilePreview
}))
const MarkdownPreview = React.lazy(async () => ({
  default: (await import('./MarkdownPreview.js')).MarkdownPreview
}))

interface FileTreeNode {
  name: string
  path?: string
  children: FileTreeNode[]
}

const SIDEBAR_WIDTH_KEY = 'file-workspace-sidebar-width'
const DEFAULT_SIDEBAR_WIDTH = 240
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 480

function storedSidebarWidth(): number {
  const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
    : DEFAULT_SIDEBAR_WIDTH
}

function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', children: [] }
  for (const path of paths.sort()) {
    const parts = path.split('/')
    let parent = root
    parts.forEach((part, index) => {
      let child = parent.children.find((item) => item.name === part)
      if (!child) {
        child = { name: part, children: [] }
        parent.children.push(child)
      }
      if (index === parts.length - 1) child.path = path
      parent = child
    })
  }
  return root.children
}

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

function FileTreeItem({
  node,
  depth,
  selectedFile,
  onSelect,
  modifiedFiles,
  fileMarkers
}: {
  node: FileTreeNode
  depth: number
  selectedFile: string
  onSelect: (path: string) => void
  modifiedFiles: ReadonlySet<string>
  fileMarkers: Readonly<Record<string, { label: string; color: string }>>
}): React.JSX.Element {
  const [opened, setOpened] = React.useState(true)
  if (node.path === undefined) {
    return (
      <div>
        <UnstyledButton
          className="file-workspace-node file-workspace-directory"
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => setOpened((current) => !current)}
        >
          {opened ? (
            <IconChevronDown size={14} />
          ) : (
            <IconChevronRight size={14} />
          )}
          <IconFolder size={16} />
          <span>{node.name}</span>
        </UnstyledButton>
        <Collapse expanded={opened}>
          {node.children.map((child) => (
            <FileTreeItem
              key={`${node.name}/${child.name}`}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelect={onSelect}
              modifiedFiles={modifiedFiles}
              fileMarkers={fileMarkers}
            />
          ))}
        </Collapse>
      </div>
    )
  }
  return (
    <UnstyledButton
      className="file-workspace-node file-workspace-file"
      data-active={node.path === selectedFile || undefined}
      data-modified={modifiedFiles.has(node.path) || undefined}
      style={{ paddingLeft: 24 + depth * 16 }}
      onClick={() => onSelect(node.path!)}
    >
      {node.name.endsWith('.md') ? (
        <IconFileText size={16} />
      ) : (
        <IconFile size={16} />
      )}
      <span>{node.name}</span>
      {fileMarkers[node.path] && (
        <Badge
          size="xs"
          variant="light"
          color={fileMarkers[node.path]?.color}
          className="file-workspace-marker"
        >
          {fileMarkers[node.path]?.label}
        </Badge>
      )}
    </UnstyledButton>
  )
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
  const [sidebarWidth, setSidebarWidth] = React.useState(storedSidebarWidth)
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const currentSidebarWidth = React.useRef(sidebarWidth)
  const dragStart = React.useRef<{ pointerX: number; width: number } | null>(
    null
  )
  const tree = React.useMemo(
    () =>
      buildFileTree([
        ...new Set([...Object.keys(files), ...Object.keys(unpreviewableFiles)])
      ]),
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

  const updateSidebarWidth = (width: number, persist = false): void => {
    const workspaceWidth =
      workspaceRef.current?.getBoundingClientRect().width ?? 0
    const responsiveMaximum = workspaceWidth
      ? Math.max(MIN_SIDEBAR_WIDTH, workspaceWidth * 0.45)
      : MAX_SIDEBAR_WIDTH
    const next = Math.round(
      Math.min(
        MAX_SIDEBAR_WIDTH,
        responsiveMaximum,
        Math.max(MIN_SIDEBAR_WIDTH, width)
      )
    )
    currentSidebarWidth.current = next
    setSidebarWidth(next)
    if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
  }
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
                    <IconPlus size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('renameFile')}>
                  <ActionIcon
                    variant="subtle"
                    aria-label={t('renameFile')}
                    disabled={!selectedFile}
                    onClick={() => openOperation('rename')}
                  >
                    <IconPencil size={16} />
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
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          )}
          <ScrollArea className="file-workspace-files">
            {tree.map((node) => (
              <FileTreeItem
                key={node.name}
                node={node}
                depth={0}
                selectedFile={selectedFile}
                onSelect={onSelectFile}
                modifiedFiles={modifiedFiles}
                fileMarkers={fileMarkers}
              />
            ))}
          </ScrollArea>
        </div>
        <div
          className="file-workspace-splitter"
          role="separator"
          aria-label={t('resizeFileTree')}
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            updateSidebarWidth(
              sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16),
              true
            )
          }}
          onPointerDown={(event) => {
            dragStart.current = { pointerX: event.clientX, width: sidebarWidth }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (dragStart.current)
              updateSidebarWidth(
                dragStart.current.width +
                  event.clientX -
                  dragStart.current.pointerX
              )
          }}
          onPointerUp={(event) => {
            if (!dragStart.current) return
            dragStart.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
            localStorage.setItem(
              SIDEBAR_WIDTH_KEY,
              String(currentSidebarWidth.current)
            )
          }}
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
              {t('previewUnavailableDescription').replace(
                '{size}',
                formatBytes(unpreviewable.sizeBytes)
              )}
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
        <Text>{t('deleteFileWarning').replace('{file}', selectedFile)}</Text>
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
