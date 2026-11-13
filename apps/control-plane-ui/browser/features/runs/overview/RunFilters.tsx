import React from 'react'
import { Box, Button, Group, Select, Text } from '@mantine/core'
import { IconAdjustmentsHorizontal, IconChevronDown } from '@tabler/icons-react'
import { useMessages } from '../../../shared/i18n.js'
import { ICON_SIZE } from '../../../shared/design.js'
import {
  EXECUTION_STATUSES,
  PREPARATION_STATUSES,
  executionStatusLabel,
  preparationStateLabel,
  runPublicationStatusLabel
} from '../status.js'
import { workflowLabel } from '../format.js'

export function RunFilters({
  search,
  onChange,
  onClear
}: {
  search: URLSearchParams
  onChange: (name: string, value: string) => void
  onClear: () => void
}): React.JSX.Element {
  const t = useMessages()
  const [opened, setOpened] = React.useState(false)
  const controlsId = React.useId()
  const filters = [
    {
      name: 'source_platform',
      label: t('platform'),
      options: [{ value: 'github', label: t('platformGithub') }]
    },
    {
      name: 'workflow',
      label: t('workflow'),
      options: ['issue-review', 'pull-request-review', 'repository-review'].map(
        (value) => ({ value, label: workflowLabel(value, t) })
      )
    },
    {
      name: 'preparation_status',
      label: t('preparation'),
      options: PREPARATION_STATUSES.map((value) => ({
        value,
        label: preparationStateLabel(value, t)
      }))
    },
    {
      name: 'execution_status',
      label: t('execution'),
      options: EXECUTION_STATUSES.map((value) => ({
        value,
        label: executionStatusLabel(value, t)
      }))
    },
    {
      name: 'publication_status',
      label: t('publication'),
      options: (
        ['pending', 'publishing', 'published', 'failed', 'skipped'] as const
      ).map((value) => ({ value, label: runPublicationStatusLabel(value, t) }))
    },
    {
      name: 'range',
      label: t('timeRange'),
      options: [
        { value: '1h', label: t('lastHour') },
        { value: '24h', label: t('lastDay') },
        { value: '7d', label: t('lastWeek') }
      ]
    }
  ]
  const activeFilters = filters.flatMap(({ name, label, options }) => {
    const value = search.get(name)
    return value
      ? [
          `${label}: ${options.find((option) => option.value === value)?.label ?? value}`
        ]
      : []
  })
  for (const [name, label] of [
    ['from', t('filterFrom')],
    ['to', t('filterTo')]
  ]) {
    const value = search.get(name)
    if (value) activeFilters.push(`${label}: ${value}`)
  }
  return (
    <Box className="operations-bar" mb="lg">
      <Group
        className="operations-filter-heading"
        justify="space-between"
        gap="xs"
      >
        <Button
          className="operations-filter-toggle"
          variant="subtle"
          leftSection={<IconAdjustmentsHorizontal size={ICON_SIZE.md} />}
          rightSection={
            <IconChevronDown
              size={ICON_SIZE.sm}
              style={{ transform: opened ? 'rotate(180deg)' : undefined }}
            />
          }
          onClick={() => setOpened((value) => !value)}
          aria-expanded={opened}
          aria-controls={controlsId}
        >
          {t('filters')}
          {activeFilters.length > 0 ? ` (${activeFilters.length})` : ''}
        </Button>
        {activeFilters.length > 0 && (
          <Button variant="subtle" onClick={onClear}>
            {t('clearFilters')}
          </Button>
        )}
      </Group>
      <div
        id={controlsId}
        className="operations-filter-grid"
        data-opened={opened}
      >
        {filters.map(({ name, label, options }) => (
          <Select
            key={name}
            label={label}
            value={search.get(name) || 'all'}
            onChange={(value) =>
              onChange(name, value === null || value === 'all' ? '' : value)
            }
            data={[{ value: 'all', label: t('all') }, ...options]}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
        ))}
      </div>
      {activeFilters.length > 0 && (
        <Text className="operations-filter-summary" size="sm" c="var(--muted)">
          {activeFilters.join(' · ')}
        </Text>
      )}
    </Box>
  )
}
