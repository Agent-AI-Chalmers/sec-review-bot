import React from 'react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

import { ExecutionStatistics } from '../../browser/features/runs/ExecutionStatistics.js'
import type { Run } from '../../browser/features/runs/api.js'
import { renderComponent } from './render.js'

const statistics: NonNullable<Run['execution_statistics']> = {
  reconciliation_status: 'settled',
  ingestion_status: 'settled',
  usage_coverage: 'complete_for_observed_calls',
  root_trace_count: 1,
  excluded_non_review_root_count: 0,
  observed_call_count: 2,
  usage_reported_call_count: 2,
  token_usage: {
    input_tokens: 5_200,
    output_tokens: 1_000,
    total_tokens: 6_200,
    cache_read_input_tokens: 1_600,
    cache_creation_input_tokens: 104,
    reasoning_tokens: 150
  },
  groups: [],
  settled_at: '2026-10-23T07:42:10Z',
  updated_at: '2026-10-23T07:42:10Z'
}

test('execution details open in a drawer with the token breakdown', async () => {
  const user = userEvent.setup()
  renderComponent(
    <ExecutionStatistics
      statistics={statistics}
      workflow="pull-request-review"
    />
  )

  expect(screen.getByText('2 Calls · 6,200 tokens')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'View details' }))

  const drawer = await screen.findByRole('dialog')
  expect(
    within(drawer).getByText('Agent Execution Details')
  ).toBeInTheDocument()
  expect(within(drawer).getByText('5,200')).toBeInTheDocument()
  expect(within(drawer).getByText('Cache read 1,600')).toBeInTheDocument()
  expect(within(drawer).getByText('Cache write 104')).toBeInTheDocument()
  expect(within(drawer).getByText('Reasoning 150')).toBeInTheDocument()
})

test('empty and partial snapshots expose only their applicable states', () => {
  const empty: NonNullable<Run['execution_statistics']> = {
    ...statistics,
    ingestion_status: 'no_observations',
    usage_coverage: null,
    observed_call_count: 0,
    usage_reported_call_count: 0,
    token_usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null
    }
  }
  const { rerender } = renderComponent(
    <ExecutionStatistics statistics={empty} workflow="pull-request-review" />
  )

  expect(screen.getByTestId('statistics-no-observations')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'View details' })
  ).not.toBeInTheDocument()

  rerender(
    <ExecutionStatistics
      statistics={{
        ...statistics,
        ingestion_status: 'partial_window',
        usage_coverage: 'partial'
      }}
      workflow="pull-request-review"
    />
  )

  expect(screen.getByTestId('statistics-warning')).toBeInTheDocument()
  expect(
    screen.queryByTestId('statistics-no-observations')
  ).not.toBeInTheDocument()
})

test('statistics render in the selected language', () => {
  renderComponent(
    <ExecutionStatistics
      statistics={statistics}
      workflow="pull-request-review"
    />,
    { language: 'zh' }
  )

  expect(screen.getByText('模型用量')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看明细' })).toBeInTheDocument()
})
