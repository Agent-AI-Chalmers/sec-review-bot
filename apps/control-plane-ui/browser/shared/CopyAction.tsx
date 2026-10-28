import React from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'

import { useMessages } from './i18n.js'
import { ICON_SIZE } from './design.js'

/** Copies a value and confirms it briefly; used for run ids and artifact digests. */
export function CopyAction({
  value,
  name,
  copiedName
}: {
  value: string
  name: string
  copiedName: string
}): React.JSX.Element {
  const t = useMessages()
  const [copied, setCopied] = React.useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  const text = copied ? copiedName : name
  return (
    <>
      <Tooltip label={copied ? t('copied') : t('copy')}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={text}
          onClick={() => void copy()}
        >
          {copied ? (
            <IconCheck size={ICON_SIZE.sm} />
          ) : (
            <IconCopy size={ICON_SIZE.sm} />
          )}
        </ActionIcon>
      </Tooltip>
      <span className="visually-hidden" aria-live="polite">
        {copied ? copiedName : ''}
      </span>
    </>
  )
}
