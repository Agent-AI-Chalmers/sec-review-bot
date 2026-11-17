import { expect, test } from 'vitest'

import { validateIconContract } from '../scripts/icon-contract.js'

test('icon imports and rendered sizes follow the shared contract', () => {
  const issues = validateIconContract({
    'example.tsx': `
      import { IconAlertTriangle } from './local-icons.js'
      const good = <IconCheck size={ICON_SIZE.sm} />
      const bad = <IconAlertTriangle size={17} />
    `
  })

  expect(issues.map((issue) => issue.message)).toStrictEqual([
    'IconAlertTriangle must come from @tabler/icons-react',
    'IconAlertTriangle size must use ICON_SIZE'
  ])
})
