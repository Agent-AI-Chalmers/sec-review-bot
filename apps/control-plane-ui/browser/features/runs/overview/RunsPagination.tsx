import type React from 'react'
import { Group, Pagination, Select, Text } from '@mantine/core'
import { useMessages } from '../../../shared/i18n.js'

const PAGE_SIZES: readonly number[] = [10, 20, 50, 100]

export function RunsPagination({
  pageSize,
  page,
  total,
  onPageSizeChange,
  onPreviousPage,
  onNextPage
}: {
  pageSize: number
  page: number
  total: number
  onPageSizeChange: (value: string) => void
  onPreviousPage: () => void
  onNextPage: () => void
}): React.JSX.Element {
  const t = useMessages()
  const pageSizeOptions = PAGE_SIZES.includes(pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, pageSize].sort((left, right) => left - right)
  // Keep page size and navigation on the same baseline; single-page results still offer page size.
  return (
    <Group justify="space-between" align="center" mt="md" wrap="wrap" gap="md">
      <Group gap={6} align="center" wrap="nowrap">
        <Text size="sm" c="var(--muted)">
          {t('perPage')}
        </Text>
        <Select
          aria-label={t('perPage')}
          size="xs"
          w={72}
          value={String(pageSize)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          data={pageSizeOptions.map((size) => String(size))}
          onChange={(value) => {
            if (value !== null) onPageSizeChange(value)
          }}
        />
      </Group>
      {total > 1 && (
        <Pagination.Root
          total={total}
          value={page}
          onPreviousPage={onPreviousPage}
          onNextPage={onNextPage}
        >
          <Group gap="xs" justify="center">
            <Pagination.Previous aria-label={t('previousPage')} />
            <Pagination.Next aria-label={t('nextPage')} />
          </Group>
        </Pagination.Root>
      )}
    </Group>
  )
}
