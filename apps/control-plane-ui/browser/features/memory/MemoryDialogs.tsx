import React from 'react'
import { Alert, Button, Group, Modal } from '@mantine/core'

import { FileWorkspace } from '../workspace/FileWorkspace.js'
import { useMessages } from '../../shared/i18n.js'

function sameFiles(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  const names = Object.keys(left)
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => left[name] === right[name])
  )
}

export function MemoryEditorDialog({
  opened,
  files,
  initialFiles,
  busy,
  onFilesChange,
  onClose,
  onCommit
}: {
  opened: boolean
  files: Record<string, string>
  initialFiles: Record<string, string>
  busy: boolean
  onFilesChange: (files: Record<string, string>) => void
  onClose: () => void
  onCommit: () => void
}): React.JSX.Element {
  const t = useMessages()
  const [selectedFile, setSelectedFile] = React.useState('MEMORY.md')
  const [discardOpen, setDiscardOpen] = React.useState(false)
  const dirty = !sameFiles(files, initialFiles)
  const modifiedFiles = React.useMemo(
    () =>
      new Set(
        Object.keys(files).filter((name) => files[name] !== initialFiles[name])
      ),
    [files, initialFiles]
  )

  React.useEffect(() => {
    if (opened) setSelectedFile('MEMORY.md')
  }, [opened])

  const requestClose = (): void => {
    if (dirty) setDiscardOpen(true)
    else onClose()
  }

  return (
    <>
      <Modal
        opened={opened}
        onClose={requestClose}
        title={t('editMemoryTreeTitle')}
        size="calc(100vw - 64px)"
        classNames={{ body: 'file-workspace-editor-modal' }}
      >
        <FileWorkspace
          files={files}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          editable
          onFilesChange={onFilesChange}
          modifiedFiles={modifiedFiles}
          className="file-workspace-editor"
        />
        <Group justify="end" className="file-workspace-editor-actions">
          <Button variant="default" onClick={requestClose}>
            {t('cancel')}
          </Button>
          <Button loading={busy} disabled={!dirty} onClick={onCommit}>
            {t('commitRevision')}
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={discardOpen}
        onClose={() => setDiscardOpen(false)}
        title={t('discardMemoryChangesTitle')}
        centered
      >
        <Alert color="yellow">{t('discardMemoryChangesWarning')}</Alert>
        <Group justify="end" mt="md">
          <Button variant="default" onClick={() => setDiscardOpen(false)}>
            {t('continueEditing')}
          </Button>
          <Button
            color="red"
            onClick={() => {
              setDiscardOpen(false)
              onClose()
            }}
          >
            {t('discardChanges')}
          </Button>
        </Group>
      </Modal>
    </>
  )
}

export function MemoryRestoreDialog({
  revision,
  busy,
  onClose,
  onConfirm
}: {
  revision: number | undefined
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useMessages()

  return (
    <Modal
      opened={revision !== undefined}
      onClose={onClose}
      title={t('restoreRevisionTitle').replace(
        '{revision}',
        String(revision ?? '')
      )}
      centered
    >
      <Alert color="yellow" mb="md">
        {t('restoreRevisionWarning').replace(
          '{revision}',
          String(revision ?? '')
        )}
      </Alert>
      <Group justify="end" mt="md">
        <Button variant="default" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button loading={busy} onClick={onConfirm}>
          {t('confirmRestore')}
        </Button>
      </Group>
    </Modal>
  )
}
