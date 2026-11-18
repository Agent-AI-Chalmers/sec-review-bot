import React from 'react'
import { userEvent, page } from 'vitest/browser'
import { expect, test } from 'vitest'

import { StateMachineDiagram } from '../../browser/features/runs/detail/StateMachineDiagram.js'
import { stateMachine } from '../../browser/features/runs/state-machines.generated.js'
import { runs } from '../../mock-api/runs/generate.js'
import { renderComponent } from './render.js'

for (const language of ['en', 'zh'] as const) {
  test(`state tooltip shows the summary rather than lifecycle details (${language})`, async () => {
    const user = userEvent.setup()
    const machine = structuredClone(stateMachine('preparation', language))
    // Distinct fixture values expose a wrong field selection without constraining contract copy.
    const detail = {
      label: language === 'en' ? 'Awaiting input' : '等待输入',
      summary: language === 'en' ? 'Short state hint.' : '简短状态提示。',
      description: language === 'en' ? 'Full lifecycle explanation.' : '完整生命周期说明。'
    }
    machine.details.pending = detail

    renderComponent(
      <StateMachineDiagram
        machine={machine}
        run={{ ...runs[0], source_platform: 'github' }}
        events={[]}
      />,
      { language }
    )

    await user.hover(page.getByRole('img', { name: detail.label }))

    const tooltipLocator = page.getByRole('tooltip')
    // Browser assertions are asynchronous; jest-dom also declares a synchronous overload.
    // oxlint-disable-next-line typescript/await-thenable
    await expect.element(tooltipLocator).toBeVisible()
    const tooltip = tooltipLocator.element()
    expect(tooltip).toHaveTextContent(detail.summary)
    expect(tooltip).not.toHaveTextContent(detail.description)
  })
}
