import React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { MemoryRevisionHistory } from '../../browser/features/memory/MemoryRevisionHistory.js'
import type { MemoryTreeRevision } from '../../browser/features/memory/api-types.generated.js'
import { renderComponent } from './render.js'

const trajectoryReference = {
  uri: 's3://test/trajectory',
  digest: `sha256:${'b'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 21
}

const revision: MemoryTreeRevision = {
  revision: 2,
  predecessor_revision: 1,
  created_at: '2026-11-09T00:00:00Z',
  memory_tree_reference: {
    uri: 's3://test/tree',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 42
  },
  source: {
    kind: 'reorganization',
    operation_id: 'reorganization-2',
    trajectory_reference: trajectoryReference,
    maintenance_report: {
      summary: 'Merged duplicate path topics.',
      observation_decisions: []
    }
  }
}

const learningRevision: MemoryTreeRevision = {
  ...revision,
  revision: 3,
  predecessor_revision: 2,
  source: {
    kind: 'learning',
    operation_id: 'learning-3',
    extraction_ids: ['extraction-1', 'extraction-2'],
    trajectory_reference: trajectoryReference,
    maintenance_report: {
      summary: 'Added one lesson and skipped a duplicate.',
      observation_decisions: [
        {
          extraction_id: 'extraction-1',
          action: 'added',
          topics: ['/memory/topics/path.md'],
          reason: 'New reusable containment check.'
        },
        {
          extraction_id: 'extraction-2',
          action: 'skipped',
          topics: [],
          reason: 'Already covered by the path topic.'
        }
      ]
    }
  }
}

test.each(['list', 'graph'])(
  'reorganization has its own label and opens its trajectory in %s view',
  (view) => {
    const onViewTrajectory = vi.fn()
    renderComponent(
      <MemoryRevisionHistory
        revisions={[revision]}
        activeRevision={2}
        loading={false}
        error=""
        view={view}
        highlightedRevision={undefined}
        onViewChange={vi.fn()}
        onViewFiles={vi.fn()}
        onViewTrajectory={onViewTrajectory}
        onCompare={vi.fn()}
        onSetCurrent={vi.fn()}
        onHighlightEnd={vi.fn()}
      />
    )
    expect(screen.getAllByText(/Reorganization/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Operator edit')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trajectory' }))
    expect(onViewTrajectory).toHaveBeenCalledWith(2)
  }
)

function renderHistory(
  revisions: MemoryTreeRevision[],
  view: string = 'list'
): void {
  renderComponent(
    <MemoryRevisionHistory
      revisions={revisions}
      activeRevision={revisions[0]?.revision}
      loading={false}
      error=""
      view={view}
      highlightedRevision={undefined}
      onViewChange={vi.fn()}
      onViewFiles={vi.fn()}
      onViewTrajectory={vi.fn()}
      onCompare={vi.fn()}
      onSetCurrent={vi.fn()}
      onHighlightEnd={vi.fn()}
    />
  )
}

test.each(['list', 'graph'])(
  'the maintenance report shows the summary and each observation decision in %s view',
  async (view) => {
    renderHistory([learningRevision], view)
    fireEvent.click(screen.getByRole('button', { name: 'Maintenance report' }))
    expect(
      await screen.findByText('Added one lesson and skipped a duplicate.')
    ).toBeInTheDocument()
    expect(screen.getByText('extraction-1')).toBeInTheDocument()
    expect(screen.getByText('Added')).toBeInTheDocument()
    expect(screen.getByText('/memory/topics/path.md')).toBeInTheDocument()
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(
      screen.getByText('Already covered by the path topic.')
    ).toBeInTheDocument()
  }
)

test('a reorganization report states that no observations were consumed', async () => {
  renderHistory([revision])
  fireEvent.click(screen.getByRole('button', { name: 'Maintenance report' }))
  expect(
    await screen.findByText('Merged duplicate path topics.')
  ).toBeInTheDocument()
  expect(screen.getByText('No observations were consumed.')).toBeInTheDocument()
})
