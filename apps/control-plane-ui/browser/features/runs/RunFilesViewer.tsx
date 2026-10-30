import React from 'react'
import { Container, Modal, Text } from '@mantine/core'
import { useParams } from 'react-router-dom'

import { api } from '../../shared/api-client.js'
import { useMessages } from '../../shared/i18n.js'
import { ArtifactWorkspace } from '../workspace/ArtifactWorkspace.js'

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
  return (
    <ArtifactWorkspace
      key={runId}
      fullPage={fullPage}
      source={{
        load: async (signal) => {
          const body = await api<RunFilesResponse>(
            `/runs/${encodeURIComponent(runId)}/artifact/content`,
            { signal }
          )
          return {
            files: body.files,
            unpreviewableFiles: body.unpreviewable_files
          }
        },
        preferredFile: 'manifest.json',
        pageHref: `/runs/${encodeURIComponent(runId)}/files`,
        loadFailedMessage: 'runFilesLoadFailed',
        download: {
          href: `/api/runs/${encodeURIComponent(runId)}/artifact`,
          label: 'downloadDiagnosticBundle'
        }
      }}
    />
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
