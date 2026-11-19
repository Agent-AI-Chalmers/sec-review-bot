import { readFile, readdir } from 'node:fs/promises'

import { expect, test } from 'vitest'

import { validateIconContract } from './icon-rules.js'

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

test('multiline aliased imports and paired JSX retain source locations', () => {
  const issues = validateIconContract({
    'unicode.tsx': [
      '// 中文 🧭',
      'import {',
      '  IconAlertTriangle as IconWarning',
      "} from './local-icons.js'",
      'const valid = <IconCheck size={ICON_SIZE.sm}></IconCheck>',
      'const invalid = <IconWarning size={12}></IconWarning>',
      ''
    ].join('\n')
  })
  expect(issues).toStrictEqual([
    {
      file: 'unicode.tsx',
      line: 3,
      message: 'IconAlertTriangle must come from @tabler/icons-react'
    },
    { file: 'unicode.tsx', line: 6, message: 'IconWarning size must use ICON_SIZE' }
  ])
})

// New and edited TSX files must be scanned on every full test run. The scan is
// outside Vitest's import graph, so select this test explicitly after icon edits.
test('application icons use Tabler and the shared size scale', async () => {
  const browserDirectory = new URL('../../browser/', import.meta.url)
  const files = (await readdir(browserDirectory, { recursive: true }))
    .filter((file) => file.endsWith('.tsx'))
    .sort()
  expect(files.length).toBeGreaterThan(0)
  const sources = Object.fromEntries(
    await Promise.all(
      files.map(
        async (file) =>
          [`browser/${file}`, await readFile(new URL(file, browserDirectory), 'utf8')] as const
      )
    )
  )
  expect(validateIconContract(sources)).toStrictEqual([])
})
