import React from 'react'
import { Badge, Button, Text, UnstyledButton } from '@mantine/core'
import { IconChevronDown, IconChevronUp, IconFiles } from '@tabler/icons-react'
import type { ArtifactStorage } from '../api.js'
import { useMessages } from '../../../shared/i18n.js'
import { ICON_SIZE } from '../../../shared/design.js'
import { CopyAction } from '../../../shared/CopyAction.js'
import { RunFilesViewer } from './RunFilesViewer.js'
import { artifactStatusColor, artifactStatusLabel } from '../status.js'
import {
  abbreviateDigest,
  formatBytes,
  isDownloadableArtifact
} from '../format.js'

export function RunArtifact({
  storage,
  runId
}: {
  // Non-null: the caller only renders this when the run actually reported a storage record.
  storage: NonNullable<ArtifactStorage>
  runId: string
}): React.ReactNode {
  const t = useMessages()
  const [expanded, setExpanded] = React.useState(false)
  const [filesOpen, setFilesOpen] = React.useState(false)
  // The contract makes this a discriminated union: `available` always carries the artifact, and
  // the other statuses never do. Narrowing on the status is what the type system can check, so a
  // missing artifact can no longer be silently rendered as an empty panel.
  if (storage.status !== 'available') {
    if (!storage.message && !storage.error_code) return null
    return (
      <div className="artifact-state">
        {storage.message && <Text size="sm">{storage.message}</Text>}
        {storage.error_code && (
          <Text
            c={storage.status === 'failed' ? 'red' : 'dimmed'}
            size="xs"
            ff="monospace"
          >
            {storage.error_code}
          </Text>
        )}
      </div>
    )
  }
  const artifact = storage.artifact
  const hex = artifact.digest.replace(/^sha256:/, '')
  return (
    <>
      <div className="artifact-panel">
        <div className="artifact-row">
          <Badge variant="light" color={artifactStatusColor(storage.status)}>
            {artifactStatusLabel(storage.status, t)}
          </Badge>
          <div className="artifact-facts">
            <Text c="dimmed" size="sm">
              {formatBytes(artifact.size_bytes)}
            </Text>
            <Text c="dimmed" size="xs" ff="monospace">
              {artifact.media_type}
            </Text>
            <div className="artifact-digest-row">
              <Text c="dimmed" size="xs">
                {t('sha256')}
              </Text>
              <UnstyledButton
                type="button"
                className="artifact-digest-toggle"
                aria-expanded={expanded}
                aria-label={expanded ? t('collapseDigest') : t('expandDigest')}
                onClick={() => setExpanded((value) => !value)}
              >
                <code>{expanded ? hex : abbreviateDigest(hex)}</code>
                {expanded ? (
                  <IconChevronUp size={ICON_SIZE.sm} />
                ) : (
                  <IconChevronDown size={ICON_SIZE.sm} />
                )}
              </UnstyledButton>
              <CopyAction
                value={artifact.digest}
                name={t('copyDigest')}
                copiedName={t('digestCopied')}
              />
            </div>
          </div>
          {isDownloadableArtifact(storage) && (
            <Button
              className="artifact-actions"
              variant="default"
              size="xs"
              leftSection={<IconFiles size={ICON_SIZE.sm} />}
              onClick={() => setFilesOpen(true)}
            >
              {t('viewRunFiles')}
            </Button>
          )}
        </div>
      </div>
      <RunFilesViewer
        runId={filesOpen ? runId : undefined}
        onClose={() => setFilesOpen(false)}
      />
    </>
  )
}
