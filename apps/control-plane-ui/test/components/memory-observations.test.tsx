import React from 'react'
import { screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, expect, test, vi } from 'vitest'

import { MemoryObservationList } from '../../browser/features/memory/MemoryObservationList.js'
import type { ObservationRecord } from '../../browser/features/memory/api-types.generated.js'
import { renderComponent } from './render.js'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function observation(index: number): ObservationRecord {
  return {
    extraction_id: `extraction-${index}`,
    observation_id: `observation-${index}`,
    source_run_id: `run-${index}`,
    source_unit_id: 'unit',
    body_markdown: `Observation ${index}`,
    consumed_revision: 2,
    created_at: '2026-11-09T00:00:00Z'
  }
}

function renderList(
  props: Partial<React.ComponentProps<typeof MemoryObservationList>>
): void {
  renderComponent(
    <MemoryRouter>
      <MemoryObservationList
        observations={[observation(1)]}
        loading={false}
        error=""
        pagination={{
          pageSize: 20,
          page: 1,
          total: 1,
          onPageSizeChange: vi.fn(),
          onPreviousPage: vi.fn(),
          onNextPage: vi.fn()
        }}
        revisionFilter={undefined}
        onClearRevisionFilter={vi.fn()}
        highlightedObservation={undefined}
        onHighlightEnd={vi.fn()}
        onRevealRevision={vi.fn()}
        onViewTrajectory={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  )
}

test('the revision filter banner names the filtered revision', () => {
  renderList({ revisionFilter: 2 })
  expect(
    screen.getByText('Showing observations included in revision 2.')
  ).toBeInTheDocument()
})

test('a revealed observation is highlighted once it is in the list', () => {
  renderList({ highlightedObservation: 'observation-1' })
  const row = document.querySelector('[data-observation-row="observation-1"]')
  expect(row).toHaveAttribute('data-highlighted')
})

test('a revealed observation missing from the page is reported without its id', () => {
  renderList({ highlightedObservation: 'observation-9' })
  expect(
    screen.getByText('This observation is not on this page.')
  ).toBeInTheDocument()
  expect(screen.queryByText(/extraction-9/)).not.toBeInTheDocument()
})

test('the observation list offers the shared cursor pager', () => {
  renderList({})
  expect(screen.getAllByLabelText('Rows per page').length).toBeGreaterThan(0)
})
