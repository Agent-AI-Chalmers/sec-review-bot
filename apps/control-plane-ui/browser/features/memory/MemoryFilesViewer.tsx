import React from 'react'
import { ActionIcon, Button, Group, Modal, Tooltip } from '@mantine/core'
import { IconDownload, IconExternalLink } from '@tabler/icons-react'

import {
  api,
  isAbortError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { FileWorkspace } from '../workspace/FileWorkspace.js'
import { ResourceLoadError } from '../../shared/ResourceLoadError.js'
import { useMessages } from '../../shared/i18n.js'

export function MemoryFilesContent({
  revision,
  fullPage = false
}: {
  revision: number
  fullPage?: boolean
}): React.JSX.Element {
  const t = useMessages()
  const [files, setFiles] = React.useState<Record<string, string>>({})
  const [selectedFile, setSelectedFile] = React.useState('')
  const [error, setError] = React.useState<unknown>()

  React.useEffect(() => {
    const controller = new AbortController()
    setFiles({})
    setSelectedFile('')
    setError(undefined)
    void api<{ files: Record<string, string> }>(
      `/memory/revisions/${revision}/content`,
      { signal: controller.signal }
    )
      .then((body) => {
        if (controller.signal.aborted) return
        setFiles(body.files)
        const names = Object.keys(body.files).sort()
        setSelectedFile(
          names.includes('MEMORY.md') ? 'MEMORY.md' : (names[0] ?? '')
        )
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !isAbortError(failure))
          setError(failure)
      })
    return (): void => controller.abort()
  }, [revision, t])

  throwIfUnauthorized(error)

  const toolbar = (
    <Group gap="sm" wrap="nowrap">
      {!fullPage && (
        <Tooltip label={t('openFullPage')}>
          <ActionIcon
            component="a"
            href={`/memory/revisions/${revision}/tree`}
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
      <Tooltip label={t('downloadMemoryTree')}>
        <ActionIcon
          component="a"
          href={`/api/memory/revisions/${revision}/artifact`}
          download
          variant="default"
          size="lg"
          aria-label={t('downloadMemoryTree')}
        >
          <IconDownload size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )

  if (error !== undefined)
    return (
      <div className="content-load-state">
        <ResourceLoadError
          message={t('memoryFilesLoadFailed')}
          actions={
            <Button
              component="a"
              href={`/api/memory/revisions/${revision}/artifact`}
              download
              variant="default"
              leftSection={<IconDownload size={16} />}
            >
              {t('downloadMemoryTree')}
            </Button>
          }
        />
      </div>
    )

  return (
    <>
      <FileWorkspace
        files={files}
        selectedFile={selectedFile}
        onSelectFile={setSelectedFile}
        toolbar={toolbar}
      />
    </>
  )
}

export function MemoryFilesViewer({
  revision,
  onClose
}: {
  revision: number | undefined
  onClose: () => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Modal
      opened={revision !== undefined}
      onClose={onClose}
      title={t('memoryFilesRevision').replace(
        '{revision}',
        String(revision ?? '')
      )}
      size="calc(100vw - 64px)"
      classNames={{ body: 'file-workspace-modal' }}
    >
      {revision !== undefined && <MemoryFilesContent revision={revision} />}
    </Modal>
  )
}
