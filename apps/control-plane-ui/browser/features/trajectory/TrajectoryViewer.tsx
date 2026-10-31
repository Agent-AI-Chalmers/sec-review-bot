import React from 'react'
import { ActionIcon, Group, Modal, Text, Tooltip } from '@mantine/core'
import { IconDownload, IconExternalLink, IconRoute } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import { TrajectoryContent } from './TrajectoryContent.js'

export interface TrajectoryTarget {
  title: string
  contentHref: string
  downloadHref: string
  pageHref: string
}

export function TrajectoryViewer({
  target,
  onClose
}: {
  target: TrajectoryTarget | undefined
  onClose: () => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Modal
      opened={target !== undefined}
      onClose={onClose}
      title={
        target ? (
          <div className="trajectory-viewer-heading">
            <Group gap="sm" wrap="nowrap" className="trajectory-viewer-name">
              <IconRoute size={ICON_SIZE.lg} aria-hidden="true" />
              <Text fw={600} truncate>
                {target.title}
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t('openFullPage')}>
                <ActionIcon
                  component="a"
                  href={target.pageHref}
                  target="_blank"
                  rel="noreferrer"
                  variant="default"
                  size="lg"
                  aria-label={t('openFullPage')}
                >
                  <IconExternalLink size={ICON_SIZE.md} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t('downloadOriginal')}>
                <ActionIcon
                  component="a"
                  href={target.downloadHref}
                  download
                  variant="default"
                  size="lg"
                  aria-label={t('downloadOriginal')}
                >
                  <IconDownload size={ICON_SIZE.md} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </div>
        ) : undefined
      }
      size="calc(100vw - 64px)"
      classNames={{
        header: 'trajectory-viewer-header',
        title: 'trajectory-viewer-title',
        body: 'memory-viewer-modal'
      }}
    >
      {target && (
        <TrajectoryContent
          contentHref={target.contentHref}
          minimapPlacement="container"
        />
      )}
    </Modal>
  )
}
