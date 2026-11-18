import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { CodeEditor } from '../../browser/features/workspace/CodeEditor.js'

test('long editor lines wrap within a narrow workspace', async () => {
  const screen = await render(
    <div style={{ width: 260 }}>
      <CodeEditor
        value={'A repository-specific observation. '.repeat(20)}
        onChange={vi.fn()}
        ariaLabel="Memory content"
        language="text"
      />
    </div>
  )
  const content = screen.getByRole('textbox', { name: 'Memory content' })
  // Browser matchers retry asynchronously; shared jest-dom declarations also expose a void signature.
  // oxlint-disable-next-line typescript/await-thenable
  await expect.element(content).toBeVisible()
  // jsdom has no layout: actual line height and overflow need a browser.
  await expect
    .poll(() => {
      const element = content.element()
      const line = element.querySelector('.cm-line')
      return line?.getBoundingClientRect().height ?? 0
    })
    .toBeGreaterThan(40)
  expect(content.element().scrollWidth).toBeLessThanOrEqual(
    content.element().clientWidth + 1
  )
})
