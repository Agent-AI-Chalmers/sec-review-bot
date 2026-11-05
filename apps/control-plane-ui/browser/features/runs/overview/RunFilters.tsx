import React from 'react'
import { Box, Button, Collapse, Group, Select } from '@mantine/core'
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

interface FilterOption {
  value: string
  label: string
}

function FilterSelect({
  width,
  label,
  value,
  options,
  onChange
}: {
  width: number
  label: string
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Select
      w={width}
      label={label}
      value={value === '' ? 'all' : value}
      onChange={(next) => onChange(next === null || next === 'all' ? '' : next)}
      data={[{ value: 'all', label: t('all') }, ...options]}
      allowDeselect={false}
      comboboxProps={{ withinPortal: true }}
    />
  )
}

export function RunFilters({
  search,
  onChange
}: {
  search: URLSearchParams
  onChange: (name: string, value: string) => void
}): React.JSX.Element {
  const t = useMessages()
  const [moreFiltersOpened, setMoreFiltersOpened] = React.useState(() =>
    search.has('range')
  )
  return (
    <Box className="operations-bar" mb="lg">
      {/* Page size lives with the pager below the table, where "how many per page" is asked. */}
      <div className="operations-row">
        <Group
          className="operations-filter-groups"
          aria-label="Run list controls"
          align="flex-end"
          gap="md"
        >
          <Group className="operations-filter-group" align="flex-end" gap="md">
            <FilterSelect
              width={120}
              label={t('platform')}
              value={search.get('source_platform') ?? ''}
              onChange={(value) => onChange('source_platform', value)}
              options={[{ value: 'github', label: t('platformGithub') }]}
            />
            <FilterSelect
              width={150}
              label={t('workflow')}
              value={search.get('workflow') ?? ''}
              onChange={(value) => onChange('workflow', value)}
              options={[
                'issue-review',
                'pull-request-review',
                'repository-review'
              ].map((value) => ({ value, label: workflowLabel(value, t) }))}
            />
          </Group>
          <Group className="operations-filter-group" align="flex-end" gap="md">
            <FilterSelect
              width={130}
              label={t('preparation')}
              value={search.get('preparation_status') ?? ''}
              onChange={(value) => onChange('preparation_status', value)}
              options={PREPARATION_STATUSES.map((value) => ({
                value,
                label: preparationStateLabel(value, t)
              }))}
            />
            <FilterSelect
              width={160}
              label={t('execution')}
              value={search.get('execution_status') ?? ''}
              onChange={(value) => onChange('execution_status', value)}
              options={EXECUTION_STATUSES.map((value) => ({
                value,
                label: executionStatusLabel(value, t)
              }))}
            />
            <FilterSelect
              width={130}
              label={t('publication')}
              value={search.get('publication_status') ?? ''}
              onChange={(value) => onChange('publication_status', value)}
              options={(
                [
                  'pending',
                  'publishing',
                  'published',
                  'failed',
                  'skipped'
                ] as const
              ).map((value) => ({
                value,
                label: runPublicationStatusLabel(value, t)
              }))}
            />
          </Group>
          <Button
            variant={search.has('range') ? 'light' : 'subtle'}
            leftSection={<IconAdjustmentsHorizontal size={ICON_SIZE.md} />}
            rightSection={
              <IconChevronDown
                size={ICON_SIZE.sm}
                style={{
                  transform: moreFiltersOpened ? 'rotate(180deg)' : undefined,
                  transition: 'transform 150ms ease'
                }}
              />
            }
            onClick={() => setMoreFiltersOpened((opened) => !opened)}
            aria-expanded={moreFiltersOpened}
          >
            {t('moreFilters')}
          </Button>
        </Group>
      </div>
      <Collapse expanded={moreFiltersOpened}>
        <Group className="operations-more" mt="md" align="flex-end">
          <FilterSelect
            width={140}
            label={t('timeRange')}
            value={search.get('range') ?? ''}
            onChange={(value) => onChange('range', value)}
            options={[
              { value: '1h', label: t('lastHour') },
              { value: '24h', label: t('lastDay') },
              { value: '7d', label: t('lastWeek') }
            ]}
          />
        </Group>
      </Collapse>
    </Box>
  )
}
