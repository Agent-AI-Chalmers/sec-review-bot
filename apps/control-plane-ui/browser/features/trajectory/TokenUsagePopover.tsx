import React from 'react'
import { Button, Popover, Text } from '@mantine/core'
import { IconCpu } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import type { UsageView } from './trajectory-model.js'

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2
  }).format(value)
}

function TokenUsageDetails({ usage }: { usage: UsageView }): React.JSX.Element {
  const t = useMessages()
  const metric = (
    label: string,
    value: number | undefined,
    subsets: ReadonlyArray<readonly [string, number | undefined]> = []
  ): React.JSX.Element | null => {
    if (value === undefined && subsets.every(([, item]) => item === undefined))
      return null
    return (
      <div className="trajectory-usage-group">
        <div className="trajectory-usage-metric">
          <Text size="xs">{label}</Text>
          <Text size="sm" fw={600}>
            {value === undefined ? '—' : value.toLocaleString()}
          </Text>
        </div>
        {subsets.map(
          ([subsetLabel, subsetValue]) =>
            subsetValue !== undefined && (
              <div className="trajectory-usage-subset" key={subsetLabel}>
                <Text size="xs" c="dimmed">
                  {subsetLabel}
                </Text>
                <Text size="xs" c="dimmed">
                  {subsetValue.toLocaleString()}
                </Text>
              </div>
            )
        )}
      </div>
    )
  }
  return (
    <div className="trajectory-usage-details">
      {metric(t('trajectoryTokensIn'), usage.input, [
        [t('trajectoryCacheRead'), usage.cacheRead],
        [t('trajectoryCacheCreation'), usage.cacheCreation]
      ])}
      {metric(t('trajectoryTokensOut'), usage.output, [
        [t('trajectoryReasoningTokens'), usage.reasoning]
      ])}
      {usage.total !== undefined && (
        <div className="trajectory-usage-total">
          <Text size="xs">{t('trajectoryTokensTotal')}</Text>
          <Text size="sm" fw={600}>
            {usage.total.toLocaleString()}
          </Text>
        </div>
      )}
    </div>
  )
}

export function TokenUsagePopover({
  usage,
  compact = false
}: {
  usage: UsageView
  compact?: boolean
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Popover
      width={248}
      position="bottom-end"
      shadow="xs"
      withArrow
      arrowSize={8}
    >
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          leftSection={<IconCpu size={ICON_SIZE.xs} />}
          aria-label={t('trajectoryUsageDetails')}
        >
          {compact
            ? usage.total === undefined
              ? t('trajectoryUsageDetails')
              : formatTokens(usage.total)
            : usage.total === undefined
              ? t('trajectoryUsageDetails')
              : `${formatTokens(usage.total)} ${t('trajectoryTokenUnit')}`}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <TokenUsageDetails usage={usage} />
      </Popover.Dropdown>
    </Popover>
  )
}
