import React from 'react'
import {
  ActionIcon,
  Alert,
  Container,
  Group,
  Modal,
  Text,
  Tooltip
} from '@mantine/core'
import { IconDownload, IconExternalLink } from '@tabler/icons-react'
import { useParams } from 'react-router-dom'

import {
  api,
  isAbortError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { FileWorkspace } from '../workspace/FileWorkspace.js'
import { useMessages } from '../../shared/i18n.js'

interface RunFilesResponse {
  files: Record<string, string>
  unpreviewable_files: Record<string, { sizeBytes: number }>
}

export function RunFilesContent({
  runId,
  fullPage = false
}: {
  runId: string
  fullPage?: boolean
}): React.JSX.Element {
  const t = useMessages()
  const [files, setFiles] = React.useState<Record<string, string>>({})
  const [unpreviewableFiles, setUnpreviewableFiles] = React.useState<
    Record<string, { sizeBytes: number }>
  >({})
  const [selectedFile, setSelectedFile] = React.useState('')
  const [error, setError] = React.useState<unknown>()

  React.useEffect(() => {
    const controller = new AbortController()
    setFiles({})
    setUnpreviewableFiles({})
    setSelectedFile('')
    setError(undefined)
    void api<RunFilesResponse>(
      `/runs/${encodeURIComponent(runId)}/artifact/content`,
      { signal: controller.signal }
    )
      .then((body) => {
        if (controller.signal.aborted) return
        setFiles(body.files)
        setUnpreviewableFiles(body.unpreviewable_files)
        const names = [
          ...new Set([
            ...Object.keys(body.files),
            ...Object.keys(body.unpreviewable_files)
          ])
        ].sort()
        setSelectedFile(
          names.includes('manifest.json') ? 'manifest.json' : (names[0] ?? '')
        )
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !isAbortError(failure))
          setError(failure)
      })
    return (): void => controller.abort()
  }, [runId, t])

  throwIfUnauthorized(error)

  return (
    <>
      {error !== undefined && (
        <Alert color="red">{t('runFilesLoadFailed')}</Alert>
      )}
      {error === undefined && !selectedFile && (
        <Text c="dimmed">{t('loading')}</Text>
      )}
      {selectedFile && (
        <FileWorkspace
          files={files}
          unpreviewableFiles={unpreviewableFiles}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          toolbar={
            <Group gap="sm" wrap="nowrap">
              {!fullPage && (
                <Tooltip label={t('openFullPage')}>
                  <ActionIcon
                    component="a"
                    href={`/runs/${encodeURIComponent(runId)}/files`}
                    target="_blank"
                    rel="noreferrer"
                    variant="default"
                    size="lg"
                  >
                    <IconExternalLink size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label={t('downloadDiagnosticBundle')}>
                <ActionIcon
                  component="a"
                  href={`/api/runs/${encodeURIComponent(runId)}/artifact`}
                  download
                  variant="default"
                  size="lg"
                >
                  <IconDownload size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
          }
        />
      )}
    </>
  )
}

export function RunFilesViewer({
  runId,
  onClose
}: {
  runId: string | undefined
  onClose: () => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Modal
      opened={runId !== undefined}
      onClose={onClose}
      title={t('runFiles')}
      size="calc(100vw - 64px)"
      classNames={{ body: 'file-workspace-modal' }}
    >
      {runId !== undefined && <RunFilesContent runId={runId} />}
    </Modal>
  )
}

export function RunFilesPage(): React.JSX.Element {
  const t = useMessages()
  const { runId = '' } = useParams()
  return (
    <Container fluid px="md" py="md">
      <Text fw={600} mb="md">
        {t('runFiles')}
      </Text>
      <RunFilesContent runId={runId} fullPage />
    </Container>
  )
}
