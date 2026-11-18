import React from 'react'
import { ActionIcon, Alert, Container, Group, Title, Tooltip } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useParams } from 'react-router-dom'

import { useMessages } from '../../shared/i18n.js'
import { isAbortError, throwIfUnauthorized } from '../../shared/api-client.js'
import { LoadingState } from '../../shared/StateMessage.js'
import type { MemoryTreeVersion } from './api-types.generated.js'
import { MemoryFilesContent } from './MemoryFilesViewer.js'
import {
  loadVersionRecord,
  MemoryVersionDiffContent,
  MemoryVersionDiffTitle
} from './MemoryVersionDiff.js'
import { TrajectoryContent } from '../trajectory/TrajectoryContent.js'
import type { TrajectoryTarget } from '../trajectory/TrajectoryViewer.js'
import { ICON_SIZE } from '../../shared/design.js'

function numericVersion(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined
  }
  const version = Number(value)
  return Number.isSafeInteger(version) && version > 0 ? version : undefined
}

export function MemoryFilesPage(): React.JSX.Element {
  const t = useMessages()
  const version = numericVersion(useParams().version)
  if (version === undefined) {
    return <></>
  }
  return (
    <Container fluid py="xl" px={{ base: 'md', md: 'xl' }}>
      <Title order={1} mb="lg">
        {t('memoryFilesVersion', { version: String(version) })}
      </Title>
      <MemoryFilesContent version={version} fullPage />
    </Container>
  )
}

export function VersionTrajectoryPage(): React.JSX.Element {
  const t = useMessages()
  const version = numericVersion(useParams().version)
  if (version === undefined) {
    return <></>
  }
  const target: TrajectoryTarget = {
    title: t('memoryMaintainerTrajectory'),
    contentHref: `/memory/versions/${version}/trajectory/content`,
    downloadHref: `/api/memory/versions/${version}/trajectory`,
    pageHref: `/memory/versions/${version}/trajectory`
  }
  return <TrajectoryPage target={target} />
}

export function MemoryVersionDiffPage(): React.JSX.Element {
  const t = useMessages()
  const version = numericVersion(useParams().version)
  const [record, setRecord] = React.useState<MemoryTreeVersion>()
  const [failure, setFailure] = React.useState<unknown>()
  React.useEffect(() => {
    if (version === undefined) {
      return
    }
    const controller = new AbortController()
    setRecord(undefined)
    setFailure(undefined)
    void loadVersionRecord(version, controller.signal).then(
      (nextRecord) => {
        if (!controller.signal.aborted) {
          setRecord(nextRecord)
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setFailure(error)
        }
      }
    )
    return (): void => controller.abort()
  }, [version])
  if (version === undefined) {
    return <></>
  }
  throwIfUnauthorized(failure)
  if (failure !== undefined) {
    return (
      <div className="error-fallback">
        <Alert color="red">{t('memoryDiffLoadFailed')}</Alert>
      </div>
    )
  }
  if (!record) {
    return (
      <div className="error-fallback">
        <LoadingState message={t('loading')} />
      </div>
    )
  }
  return (
    <Container fluid py="xl" px={{ base: 'md', md: 'xl' }}>
      <Title order={1} mb="lg">
        <MemoryVersionDiffTitle
          version={record.version}
          predecessorVersion={record.predecessor_version}
        />
      </Title>
      <MemoryVersionDiffContent
        version={record.version}
        predecessorVersion={record.predecessor_version}
        fullPage
      />
    </Container>
  )
}

export function ExtractionTrajectoryPage(): React.JSX.Element {
  const t = useMessages()
  const extractionId = useParams().extractionId
  if (!extractionId) {
    return <></>
  }
  const encoded = encodeURIComponent(extractionId)
  const target: TrajectoryTarget = {
    title: t('memoryExtractorTrajectory'),
    contentHref: `/memory/extractions/${encoded}/trajectory/content`,
    downloadHref: `/api/memory/extractions/${encoded}/trajectory`,
    pageHref: `/memory/extractions/${encoded}/trajectory`
  }
  return <TrajectoryPage target={target} />
}

function TrajectoryPage({ target }: { target: TrajectoryTarget }): React.JSX.Element {
  const t = useMessages()
  return (
    <Container fluid py="xl" px={{ base: 'md', md: 'xl' }}>
      <Group justify="space-between" mb="lg">
        <Title order={1}>{target.title}</Title>
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
      <TrajectoryContent contentHref={target.contentHref} />
    </Container>
  )
}
