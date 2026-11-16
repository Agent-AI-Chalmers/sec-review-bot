import React from 'react'
import { Modal } from '@mantine/core'

import type { MemoryTreeContentResponse } from '../../../shared/artifact-content.js'
import { api } from '../../shared/api-client.js'
import { useMessages } from '../../shared/i18n.js'
import { ArtifactWorkspace } from '../workspace/ArtifactWorkspace.js'

export function MemoryFilesContent({
  version,
  fullPage = false
}: {
  version: number
  fullPage?: boolean
}): React.JSX.Element {
  return (
    <ArtifactWorkspace
      key={version}
      fullPage={fullPage}
      source={{
        load: async (signal) => {
          const body = await api<MemoryTreeContentResponse>(
            `/memory/versions/${version}/content`,
            { signal }
          )
          return { files: body.files }
        },
        preferredFile: 'MEMORY.md',
        pageHref: `/memory/versions/${version}/tree`,
        loadFailedMessage: 'memoryFilesLoadFailed',
        download: {
          href: `/api/memory/versions/${version}/artifact`,
          label: 'downloadMemoryTree'
        }
      }}
    />
  )
}

export function MemoryFilesViewer({
  version,
  onClose
}: {
  version: number | undefined
  onClose: () => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Modal
      opened={version !== undefined}
      onClose={onClose}
      title={t('memoryFilesVersion', { version: String(version ?? '') })}
      size="calc(100vw - 64px)"
      classNames={{ body: 'file-workspace-modal' }}
    >
      {version !== undefined && <MemoryFilesContent version={version} />}
    </Modal>
  )
}
