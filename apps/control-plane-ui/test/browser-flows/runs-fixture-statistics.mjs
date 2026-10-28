import assert from 'node:assert/strict'

import { openPublishedRepositoryRun } from './runs-fixture-support.mjs'

export async function runFixtureRunStatisticsFlow({
  name,
  viewport,
  page,
  base,
  waitUntil
}) {
  await openPublishedRepositoryRun({ name, page, base, waitUntil })
  const statistics = page.getByTestId('execution-statistics')
  await statistics.waitFor()
  assert.doesNotMatch(
    (await statistics.textContent()) ?? '',
    /Settled/,
    `${name} a healthy statistics snapshot must not compete with execution status`
  )
  await statistics.getByRole('button', { name: /View details/ }).click()
  const statisticsDetails = page.getByTestId('execution-statistics-details')
  await statisticsDetails.waitFor()
  assert.match(
    (await statisticsDetails.textContent()) ?? '',
    /Scan stage.*6 Calls · 17,284 tokens.*Review stage.*2 cases · 14 Calls · 40,320 tokens.*Delivery stage.*5 Calls · 11,200 tokens/s,
    `${name} collapsed repository stages must retain their usage summaries`
  )
  const workflowStages = statisticsDetails.locator('.statistics-workflow-stage')
  assert.strictEqual(
    await workflowStages.count(),
    3,
    `${name} repository usage must have scan, review, and delivery stages`
  )
  assert.strictEqual(
    await statisticsDetails
      .locator('.statistics-workflow-stage-control[aria-expanded="true"]')
      .count(),
    0,
    `${name} workflow stages must start collapsed`
  )
  await workflowStages
    .nth(0)
    .locator('.statistics-workflow-stage-control')
    .click()
  const discoveryRow = workflowStages
    .nth(0)
    .locator('.statistics-group-row')
    .filter({ hasText: 'repository-discovery' })
  await discoveryRow.click()
  assert.match(
    (await workflowStages.nth(0).textContent()) ?? '',
    /Call.*Input.*Output.*discovery-chunk-0001.*2,800.*Cache read.*1,100.*Cache write.*56.*360.*Reasoning.*54.*discovery-chunk-0002.*2,700.*Cache read.*1,000.*Cache write.*54.*354.*Reasoning.*53.*discovery-chunk-0003.*2,700.*Cache read.*1,000.*Cache write.*54.*370.*Reasoning.*56.*Total.*8,200.*Cache read.*3,100.*Cache write.*164.*1,084.*Reasoning.*163/s,
    `${name} discovery details must expose per-chunk calls and token dimensions`
  )
  const triageRow = workflowStages
    .nth(0)
    .locator('.statistics-group-row')
    .filter({ hasText: 'repository-triager' })
  await triageRow.click()
  assert.match(
    (await workflowStages.nth(0).textContent()) ?? '',
    /Call.*Draft batch 1.*2,700.*Cache read.*900.*Cache write.*54.*400.*Reasoning.*60.*Draft batch 2.*2,400.*Cache read.*900.*Cache write.*48.*400.*Reasoning.*60.*Refinement.*1,800.*Cache read.*600.*Cache write.*36.*300.*Reasoning.*45.*Total.*6,900.*Cache read.*2,400.*Cache write.*138.*1,100.*Reasoning.*165/s,
    `${name} triage details must explain its batches without adding hierarchy`
  )
  await workflowStages
    .nth(1)
    .locator('.statistics-workflow-stage-control')
    .click()
  const reviewUnits = workflowStages.nth(1).locator('.statistics-unit')
  assert.strictEqual(
    await reviewUnits.count(),
    2,
    `${name} the review stage must contain its cases`
  )
  assert.match(
    (await reviewUnits.nth(0).textContent()) ?? '',
    /Case 7d9a2f6c31b4e8.*9 Calls · 26,675 tokens/s,
    `${name} a collapsed case must retain its usage summary`
  )
  await reviewUnits.nth(0).locator('.statistics-unit-control').click()
  assert.match(
    (await reviewUnits.nth(0).textContent()) ?? '',
    /Initial review.*Feedback pass 1/s,
    `${name} a case must reveal its own initial and feedback passes`
  )
  if (viewport.width >= 768) {
    const passColumnPositions = await reviewUnits
      .nth(0)
      .locator('.statistics-table')
      .evaluateAll((tables) =>
        tables
          .slice(0, 2)
          .map((table) =>
            [...table.querySelectorAll('th')].map((cell) =>
              Math.round(cell.getBoundingClientRect().left)
            )
          )
      )
    assert.deepStrictEqual(
      passColumnPositions[0],
      passColumnPositions[1],
      `${name} initial and feedback tables must share fixed column tracks`
    )
  }
  await reviewUnits.nth(1).locator('.statistics-unit-control').click()
  assert.doesNotMatch(
    (await reviewUnits.nth(1).textContent()) ?? '',
    /Initial review/,
    `${name} a case without feedback must not label its only pass as initial`
  )
  await workflowStages
    .nth(2)
    .locator('.statistics-workflow-stage-control')
    .click()
  const deliveryRows = workflowStages.nth(2).locator('.statistics-group-row')
  assert.strictEqual(
    await deliveryRows.count(),
    2,
    `${name} delivery usage must stay flat at the agent level`
  )
  const deliveryPlannerRow = deliveryRows.filter({
    hasText: 'repository-delivery-planner'
  })
  const patchSynthesizerRow = deliveryRows.filter({
    hasText: 'patch-synthesizer'
  })
  // Playwright completes the click before React necessarily commits the expanded detail row.
  await deliveryPlannerRow.click()
  await waitUntil(
    async () =>
      (await deliveryPlannerRow.getAttribute('aria-expanded')) === 'true',
    `${name} delivery planner details did not expand`
  )
  await patchSynthesizerRow.click()
  await waitUntil(
    async () =>
      (await patchSynthesizerRow.getAttribute('aria-expanded')) === 'true',
    `${name} patch synthesizer details did not expand`
  )
  assert.match(
    (await workflowStages.nth(2).textContent()) ?? '',
    /Call.*Draft batch 1.*Draft batch 2.*Refinement.*patch-synthesizer.*combined-[a-f0-9]+.*combined-[a-f0-9]+/s,
    `${name} delivery details must explain planning and patch synthesis inline`
  )
  assert.match(
    (await statisticsDetails.textContent()) ?? '',
    /repository-discovery/,
    `${name} a completed run must show its agent usage groups`
  )
  assert.match(
    (await statisticsDetails.textContent()) ?? '',
    /anthropic\/deepseek-v4-pro/,
    `${name} provider and model must share one compact identity line`
  )
  const usageRows = statisticsDetails.locator(
    '.statistics-group-row[aria-expanded="false"]'
  )
  const expandedBefore = await statisticsDetails
    .locator('.statistics-group-row[aria-expanded="true"]')
    .count()
  await usageRows.filter({ hasText: 'repository-analyzer' }).first().click()
  assert.match(
    (await statisticsDetails.textContent()) ?? '',
    /Input\s*5,200.*Cache read\s*1,600.*Cache write\s*104.*Output\s*1,000.*Reasoning\s*150/,
    `${name} an agent without subgroups must expose its token breakdown`
  )
  await usageRows
    .filter({ hasText: 'repository-cvss-v4-scorer' })
    .first()
    .click()
  assert.strictEqual(
    await statisticsDetails
      .locator('.statistics-group-row[aria-expanded="true"]')
      .count(),
    expandedBefore + 2,
    `${name} expanding one usage group must not close another`
  )
  await page.getByRole('button', { name: 'Expand all' }).click()
  assert.strictEqual(
    await statisticsDetails
      .locator('.statistics-workflow-stage-control[aria-expanded="true"]')
      .count(),
    3,
    `${name} expand all must open every workflow stage`
  )
  assert.strictEqual(
    await statisticsDetails
      .locator('.statistics-unit-control[aria-expanded="true"]')
      .count(),
    2,
    `${name} expand all must open every review case`
  )
  await page.getByRole('button', { name: 'Collapse all' }).click()
  assert.strictEqual(
    await statisticsDetails
      .locator('.statistics-workflow-stage-control[aria-expanded="true"]')
      .count(),
    0,
    `${name} collapse all must close every workflow stage`
  )
  assert.strictEqual(
    await statisticsDetails
      .locator('.statistics-group-row[aria-expanded="true"]')
      .count(),
    0,
    `${name} collapse all must close every usage group`
  )
  await page.keyboard.press('Escape')
  await statisticsDetails.waitFor({ state: 'hidden' })

  // Transitions are the run's actual state changes, not the synthetic initialization events
  // (which have no from_status). The section starts collapsed, explains each edge, and hides
  // pagination until there is more than one page.
  const transitions = page.locator('.run-transitions')
  await transitions.locator('.transitions-entry').click()
  await transitions.locator('.transitions-body').waitFor()
  assert.strictEqual(
    await transitions.locator('.state-machine-svg').count(),
    1,
    `${name} transitions must show one selected state machine at a time`
  )
  const transitionRows = transitions.locator('.run-transition')
  assert.ok(
    (await transitionRows.count()) > 0,
    `${name} the run must list its actual transitions`
  )
  assert.doesNotMatch(
    (await transitionRows.first().textContent()) ?? '',
    /—\s*→/,
    `${name} initialization events must not appear as transitions`
  )
  assert.match(
    (await transitionRows.first().textContent()) ?? '',
    /In this state for|Final state/,
    `${name} a transition must explain how long the resulting state lasted`
  )
  assert.strictEqual(
    await transitions.locator('.mantine-Pagination-root').count(),
    0,
    `${name} a single page of transitions must not render pagination`
  )
  await transitions.getByText('100%', { exact: true }).click()
  await transitions.locator('.state-machine.is-actual').waitFor()
  await transitions.getByText('Fit', { exact: true }).click()
  await transitions.locator('.state-machine.is-fit').waitFor()
}
