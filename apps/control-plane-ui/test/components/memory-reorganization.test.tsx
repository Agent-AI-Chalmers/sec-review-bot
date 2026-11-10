import React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { MemoryRevisionHistory } from '../../browser/features/memory/MemoryRevisionHistory.js'
import type { MemoryTreeRevision } from '../../browser/features/memory/api-types.generated.js'
import { renderComponent } from './render.js'

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
    trajectory_reference: {
      uri: 's3://test/trajectory',
      digest: `sha256:${'b'.repeat(64)}`,
      media_type: 'application/zstd',
      size_bytes: 21
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
