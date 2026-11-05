import React from 'react'
import {
  ActionIcon,
  Button,
  Collapse,
  Group,
  SegmentedControl,
  Tooltip
} from '@mantine/core'
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy
} from '@tabler/icons-react'
import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import { TrajectoryText } from './TrajectoryText.js'

function CopyButton({ value }: { value: string }): React.JSX.Element {
  const t = useMessages()
  const [copied, setCopied] = React.useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Tooltip label={copied ? t('copied') : t('copy')}>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={copied ? t('copied') : t('copy')}
        onClick={() => void copy()}
      >
        {copied ? (
          <IconCheck size={ICON_SIZE.sm} />
        ) : (
          <IconCopy size={ICON_SIZE.sm} />
        )}
      </ActionIcon>
    </Tooltip>
  )
}

export function TrajectorySection({
  kind,
  title,
  value,
  openedInitially = false,
  force,
  children,
  color = 'blue',
  query = ''
}: {
  kind: 'message' | 'reasoning' | 'result' | 'artifact'
  title: string
  value: string
  openedInitially?: boolean
  force: number
  children?: React.ReactNode
  query?: string
  color?: string
}): React.JSX.Element {
  const t = useMessages()
  const [mode, setMode] = React.useState('preview')
  const hasPreview = kind === 'message' || kind === 'reasoning'
  const [opened, setOpened] = React.useState(openedInitially)
  const previousForce = React.useRef(force)
  React.useEffect(() => {
    if (force === previousForce.current) return
    previousForce.current = force
    setOpened(force > 0)
  }, [force])
  return (
    <div className="trajectory-section" data-trajectory-section={kind}>
      <Group
        justify="space-between"
        wrap="nowrap"
        className="trajectory-section-header"
      >
        <Button
          variant="subtle"
          color={color}
          size="compact-sm"
          className="trajectory-section-toggle"
          aria-expanded={opened}
          onClick={() => setOpened((current) => !current)}
        >
          <Group gap={6} wrap="nowrap">
            {opened ? (
              <IconChevronDown size={ICON_SIZE.sm} />
            ) : (
              <IconChevronRight size={ICON_SIZE.sm} />
            )}
            {title}
          </Group>
        </Button>
        <Group gap="xs" wrap="nowrap">
          {hasPreview && opened && (
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={setMode}
              data={[
                { value: 'preview', label: t('preview') },
                { value: 'source', label: t('source') }
              ]}
            />
          )}
          <CopyButton value={value} />
        </Group>
      </Group>
      <Collapse expanded={opened}>
        <div className="trajectory-section-content">
          {hasPreview ? (
            <TrajectoryText query={query} mode={mode}>
              {value}
            </TrajectoryText>
          ) : (
            children
          )}
        </div>
      </Collapse>
    </div>
  )
}
