import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

import { ExecutionStatistics } from '../../browser/features/runs/detail/ExecutionStatistics.js'
import type { Run } from '../../browser/features/runs/api.js'
import { reviewRunsFixture } from '../contract-fixtures.js'
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

test.each(['en', 'zh'] as const)(
  'contract statistics retain draft, refinement and numbered feedback labels in %s',
  async (language) => {
    const user = userEvent.setup()
    const run = reviewRunsFixture('observed-run-agent-phases.json') as Run
    const labels =
      language === 'en'
        ? {
            details: 'View details',
            scan: 'Scan stage',
            review: 'Review stage',
            draft: 'Draft',
            refinement: 'Refinement',
            initial: 'Initial review',
            feedback: 'Feedback retry'
          }
        : {
            details: '查看明细',
            scan: '扫描阶段',
            review: '审查阶段',
            draft: '初稿',
            refinement: '全局修正',
            initial: '首次审查',
            feedback: '反馈重试'
          }
    renderComponent(
      <ExecutionStatistics
        statistics={run.execution_statistics}
        workflow={run.workflow}
      />,
      { language }
    )
    await user.click(screen.getByRole('button', { name: labels.details }))
    const drawer = await screen.findByRole('dialog')
    await user.click(
      within(drawer).getByRole('button', { name: new RegExp(labels.scan) })
    )
    await user.click(
      await within(drawer).findByRole('row', { name: /repository-triager/ })
    )
    await waitFor(() => {
      expect(
        within(drawer).getByText(labels.draft, { exact: true })
      ).toBeVisible()
      expect(
        within(drawer).getByText(labels.refinement, { exact: true })
      ).toBeVisible()
    })

    await user.click(
      within(drawer).getByRole('button', { name: new RegExp(labels.review) })
    )
    await user.click(
      await within(drawer).findByRole('button', { name: /Case case-1/ })
    )
    await waitFor(() => {
      expect(
        within(drawer).getByText(labels.initial, { exact: true })
      ).toBeVisible()
      expect(
        within(drawer).getByText(labels.feedback + ' 1', { exact: true })
      ).toBeVisible()
      expect(
        within(drawer).getByText(labels.feedback + ' 2', { exact: true })
      ).toBeVisible()
    })
  }
)

test('feedback without an observed retry number is not presented as retry one', async () => {
  const user = userEvent.setup()
  const run = reviewRunsFixture('observed-run-agent-phases.json') as Run
  const feedback = run.execution_statistics!.groups.find(
    (group) => group.agent_phase === 'feedback'
  )!
  renderComponent(
    <ExecutionStatistics
      statistics={{
        ...statistics,
        groups: [{ ...feedback, feedback_retry_index: null }]
      }}
      workflow="issue-review"
    />
  )
  await user.click(screen.getByRole('button', { name: 'View details' }))
  const drawer = await screen.findByRole('dialog')
  expect(
    within(drawer).getByText('Feedback retry', { exact: true })
  ).toBeInTheDocument()
  expect(
    within(drawer).queryByText('Feedback retry 1', { exact: true })
  ).not.toBeInTheDocument()
})
