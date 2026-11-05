import React from 'react'
import { screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { RunProgress } from '../../browser/features/runs/detail/RunProgress.js'
import type { ListRunPublicationStepsResponseBody } from '../../browser/features/runs/api-types.generated.js'
import { runs } from '../../scripts/dev-fixtures/runs/generate.js'
import { renderComponent } from './render.js'

test('publication attempts render from the read response even without failure details', () => {
  // The old hand-written response type read failure_count, silently hiding this counter.
  const run = runs.find((value) => value.publication.status === 'uncertain')!
  const response: ListRunPublicationStepsResponseBody = {
    run_id: run.run_id,
    publication_steps: [
      {
        step_key: 'issue:draft-pr',
        status: 'uncertain',
        attempt_count: 3,
        remote_object_url: null,
        failure_code: null,
        failure_message: null
      }
    ]
  }

  renderComponent(
    <RunProgress
      run={{ ...run, source_platform: 'github' }}
      steps={response.publication_steps}
      events={[]}
    />
  )

  expect(screen.getByText('Attempts: 3')).toBeInTheDocument()
})
