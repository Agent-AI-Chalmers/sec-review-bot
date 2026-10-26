import React from 'react'
import { Alert, Button, Container, Group, Text, Title } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useParams } from 'react-router-dom'

import { useMessages } from '../../shared/i18n.js'
import { isAbortError, throwIfUnauthorized } from '../../shared/api-client.js'
import type { components } from './api-types.generated.js'
import { MemoryFilesContent } from './MemoryFilesViewer.js'
import {
  loadRevisionRecord,
  MemoryRevisionDiffContent,
  MemoryRevisionDiffTitle
} from './MemoryRevisionDiff.js'
import {
  TranscriptContent,
  type TranscriptTarget
} from '../transcript/TranscriptViewer.js'

function numericRevision(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined
}

export function MemoryFilesPage(): React.JSX.Element {
  const t = useMessages()
  const revision = numericRevision(useParams().revision)
  if (revision === undefined) return <></>
  return (
    <Container fluid py="xl" px={{ base: 'md', md: 'xl' }}>
      <Title order={1} mb="lg">
        {t('memoryFilesRevision').replace('{revision}', String(revision))}
      </Title>
      <MemoryFilesContent revision={revision} fullPage />
    </Container>
  )
}

export function RevisionTranscriptPage(): React.JSX.Element {
  const t = useMessages()
  const revision = numericRevision(useParams().revision)
  if (revision === undefined) return <></>
  const target: TranscriptTarget = {
    title: t('maintenanceProcess'),
    contentHref: `/memory/revisions/${revision}/transcript/content`,
    downloadHref: `/api/memory/revisions/${revision}/transcript`,
    pageHref: `/memory/revisions/${revision}/transcript`
  }
  return <TranscriptPage target={target} />
}

export function MemoryRevisionDiffPage(): React.JSX.Element {
  const t = useMessages()
  const revision = numericRevision(useParams().revision)
  const [record, setRecord] =
    React.useState<components['schemas']['MemoryTreeRevision']>()
  const [failure, setFailure] = React.useState<unknown>()
  React.useEffect(() => {
    if (revision === undefined) return
    const controller = new AbortController()
    setRecord(undefined)
    setFailure(undefined)
    void loadRevisionRecord(revision, controller.signal).then(
      (nextRecord) => {
        if (!controller.signal.aborted) setRecord(nextRecord)
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error))
          setFailure(error)
      }
    )
    return (): void => controller.abort()
  }, [revision])
  if (revision === undefined) return <></>
  throwIfUnauthorized(failure)
  if (failure !== undefined)
    return (
      <div className="error-fallback">
        <Alert color="red">{t('memoryDiffLoadFailed')}</Alert>
      </div>
    )
  if (!record)
    return (
      <div className="error-fallback">
        <Text>{t('loading')}</Text>
      </div>
    )
  return (
    <Container fluid py="xl" px={{ base: 'md', md: 'xl' }}>
      <Title order={1} mb="lg">
        <MemoryRevisionDiffTitle
          revision={record.revision}
          predecessorRevision={record.predecessor_revision}
        />
      </Title>
      <MemoryRevisionDiffContent
        revision={record.revision}
        predecessorRevision={record.predecessor_revision}
        fullPage
      />
    </Container>
  )
}

export function ExtractionTranscriptPage(): React.JSX.Element {
  const t = useMessages()
  const extractionId = useParams().extractionId
  if (!extractionId) return <></>
  const encoded = encodeURIComponent(extractionId)
  const target: TranscriptTarget = {
    title: t('extractionProcess'),
    contentHref: `/memory/extractions/${encoded}/transcript/content`,
    downloadHref: `/api/memory/extractions/${encoded}/transcript`,
    pageHref: `/memory/extractions/${encoded}/transcript`
  }
  return <TranscriptPage target={target} />
}

function TranscriptPage({
  target
}: {
  target: TranscriptTarget
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Container fluid py="xl" px={{ base: 'md', md: 'xl' }}>
      <Group justify="space-between" mb="lg">
        <Title order={1}>{target.title}</Title>
        <Button
          component="a"
          href={target.downloadHref}
          download
          variant="default"
          leftSection={<IconDownload size={16} />}
        >
          {t('downloadOriginal')}
        </Button>
      </Group>
      <TranscriptContent target={target} />
    </Container>
  )
}
