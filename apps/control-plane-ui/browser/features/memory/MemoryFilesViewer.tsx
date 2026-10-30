import React from 'react'
import { Modal } from '@mantine/core'

import { api } from '../../shared/api-client.js'
import { useMessages } from '../../shared/i18n.js'
import { ArtifactWorkspace } from '../workspace/ArtifactWorkspace.js'

export function MemoryFilesContent({
  revision,
  fullPage = false
}: {
  revision: number
  fullPage?: boolean
}): React.JSX.Element {
  return (
    <ArtifactWorkspace
      key={revision}
      fullPage={fullPage}
      source={{
        load: async (signal) => {
          const body = await api<{ files: Record<string, string> }>(
            `/memory/revisions/${revision}/content`,
            { signal }
          )
          return { files: body.files }
        },
        preferredFile: 'MEMORY.md',
        pageHref: `/memory/revisions/${revision}/tree`,
        loadFailedMessage: 'memoryFilesLoadFailed',
        download: {
          href: `/api/memory/revisions/${revision}/artifact`,
          label: 'downloadMemoryTree'
        }
      }}
    />
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
