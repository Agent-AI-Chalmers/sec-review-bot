import React from 'react'
import { ActionIcon, Button, Group, Tooltip } from '@mantine/core'
import { IconDownload, IconExternalLink } from '@tabler/icons-react'

import { throwIfUnauthorized } from '../../shared/api-client.js'
import { useResource } from '../../shared/resource.js'
import { ResourceLoadError } from '../../shared/ResourceLoadError.js'
import { LoadingState } from '../../shared/StateMessage.js'
import { useMessages, type Message } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import { FileWorkspace } from './FileWorkspace.js'

export interface ArtifactFiles {
  files: Record<string, string>
  unpreviewableFiles?: Record<string, { sizeBytes: number }>
}

/**
 * One surface's view of an artifact: where its files come from, and where its chrome points.
 *
 * The records differ by feature; reading them, choosing their first file, and presenting a
 * failure do not. A source supplies only the values that genuinely differ.
 */
export interface ArtifactSource {
  /** Read the files this artifact publishes. */
  load(signal: AbortSignal): Promise<ArtifactFiles>
  /** The file to open first when the artifact carries it. */
  preferredFile: string
  /** Where the reader can open this workspace as its own page. */
  pageHref: string
  /** What the reader is told when the files cannot be read. */
  loadFailedMessage: Message
  download: { href: string; label: Message }
}

/**
 * Present one published artifact as a file workspace.
 *
 * The source is the only variation: a caller with a new artifact kind supplies a loader and
 * four values, and inherits the loading state, the first-file rule, the failure card with
 * its download action, and the toolbar. Callers that can change artifact while mounted must
 * pass a `key` so a new artifact starts from its own files.
 */
export function ArtifactWorkspace({
  source,
  fullPage = false
}: {
  source: ArtifactSource
  fullPage?: boolean
}): React.JSX.Element {
  const t = useMessages()
  const artifact = useResource(source.load)
  const [selectedFile, setSelectedFile] = React.useState('')

  const names = React.useMemo(
    () =>
      [
        ...new Set([
          ...Object.keys(artifact.data?.files ?? {}),
          ...Object.keys(artifact.data?.unpreviewableFiles ?? {})
        ])
      ].sort(),
    [artifact.data]
  )

  // This surface owns its own scheduling: it opens with the artifact it was given, and does
  // not refresh, so a mount-time load is the whole policy.
  React.useEffect(() => {
    void artifact.reload()
  }, [artifact.reload])

  // Opening on the artifact's own entry point is the difference between a workspace the
  // reader can use and one that opens on whichever file happens to sort first.
  React.useEffect(() => {
    if (names.length === 0) return
    setSelectedFile(
      names.includes(source.preferredFile)
        ? source.preferredFile
        : (names[0] ?? '')
    )
  }, [names, source.preferredFile])

  throwIfUnauthorized(artifact.error)

  if (artifact.error !== undefined)
    return (
      <div className="content-load-state">
        <ResourceLoadError
          message={t(source.loadFailedMessage)}
          actions={
            <Button
              component="a"
              href={source.download.href}
              download
              variant="default"
              leftSection={<IconDownload size={ICON_SIZE.md} />}
            >
              {t(source.download.label)}
            </Button>
          }
        />
      </div>
    )

  if (!selectedFile) return <LoadingState message={t('loading')} />

  return (
    <FileWorkspace
      files={artifact.data?.files ?? {}}
      unpreviewableFiles={artifact.data?.unpreviewableFiles ?? {}}
      selectedFile={selectedFile}
      onSelectFile={setSelectedFile}
      toolbar={
        <Group gap="sm" wrap="nowrap">
          {!fullPage && (
            <Tooltip label={t('openFullPage')}>
              <ActionIcon
                component="a"
                href={source.pageHref}
                target="_blank"
                rel="noreferrer"
                variant="default"
                size="lg"
                aria-label={t('openFullPage')}
              >
                <IconExternalLink size={ICON_SIZE.lg} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={t(source.download.label)}>
            <ActionIcon
              component="a"
              href={source.download.href}
              download
              variant="default"
              size="lg"
              aria-label={t(source.download.label)}
            >
              <IconDownload size={ICON_SIZE.lg} />
            </ActionIcon>
          </Tooltip>
        </Group>
      }
    />
  )
}
