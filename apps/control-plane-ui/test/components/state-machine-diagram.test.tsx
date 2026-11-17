import React from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

import { StateMachineDiagram } from '../../browser/features/runs/detail/StateMachineDiagram.js'
import { stateMachine } from '../../browser/features/runs/state-machines.generated.js'
import { runs } from '../../scripts/dev-fixtures/runs/generate.js'
import { renderComponent } from './render.js'

for (const language of ['en', 'zh'] as const) {
  test(`state tooltip shows the summary rather than lifecycle details (${language})`, async () => {
    const user = userEvent.setup()
    const machine = structuredClone(stateMachine('preparation', language))
    // Distinct fixture values expose a wrong field selection without constraining contract copy.
    const detail = {
      label: language === 'en' ? 'Awaiting input' : '等待输入',
      summary: language === 'en' ? 'Short state hint.' : '简短状态提示。',
      description:
        language === 'en' ? 'Full lifecycle explanation.' : '完整生命周期说明。'
    }
    machine.details.pending = detail

    renderComponent(
      <StateMachineDiagram
        machine={machine}
        run={{ ...runs[0]!, source_platform: 'github' }}
        events={[]}
      />,
      { language }
    )

    await user.hover(screen.getByRole('img', { name: detail.label }))

    const tooltip = await screen.findByRole('tooltip', {}, { timeout: 5000 })
    expect(tooltip).toHaveTextContent(detail.summary)
    expect(tooltip).not.toHaveTextContent(detail.description)
  })
}
