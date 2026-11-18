import { trajectoryCorpus } from './contract-fixtures.js'
import { expect, test } from 'vitest'
import { markdownWithoutXmlTags } from '../browser/features/trajectory/markdown-xml.js'

for (const [name, source, expected] of [
  [
    'nested XML',
    '<role>Reviewer</role>\n<instructions>\n## Checks\n\n**Keep evidence.**\n</instructions>',
    'Reviewer\n\n## Checks\n\n**Keep evidence.**\n'
  ],
  [
    'quoted attributes and namespace',
    '<review:step title="x > y">Keep <detail/>evidence.</review:step>',
    'Keep evidence.'
  ],
  [
    'inline code',
    '<instructions>Use `<role>literal</role>` and ``a`<tag/>``.</instructions>',
    'Use `<role>literal</role>` and ``a`<tag/>``.'
  ],
  [
    'fenced code inside XML',
    '<instructions>\n```xml\n<role>literal</role>\n```\n</instructions>',
    '\n```xml\n<role>literal</role>\n```\n'
  ],
  [
    'tilde and unfinished fences',
    '<instructions>\n~~~xml\n<tag/>',
    '\n~~~xml\n<tag/>'
  ],
  [
    'indented code',
    'Example:\n\n    <tag>literal</tag>\n\n<end/>',
    'Example:\n\n    <tag>literal</tag>\n\n'
  ],
  [
    'links and comparisons',
    'Visit <https://example.com> or <person@example.com>; x < y and z > w.',
    'Visit <https://example.com> or <person@example.com>; x < y and z > w.'
  ],
  [
    'escaped literal tags',
    '\\<role>literal\\</role> and <role>visible</role>',
    '\\<role>literal\\</role> and visible'
  ]
] as const) {
  test(`preview removes XML wrappers and preserves ${name}`, () => {
    expect(markdownWithoutXmlTags(source)).toBe(expected)
  })
}

test('the recorded summarization prompt keeps its instructions and Markdown sections', () => {
  const raw = trajectoryCorpus('summarization.jsonl')
  const events = raw
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string
          metadata?: { lc_source?: string }
          message: { role: string; content: string }
        }
    )
  const event = events.find(
    (event) =>
      event.event === 'message' &&
      event.metadata?.lc_source === 'summarization' &&
      event.message.role === 'user'
  )
  expect.assert(event)
  const prompt = event.message.content
  const preview = markdownWithoutXmlTags(prompt)
  expect(preview).toContain('Context Extraction Assistant')
  expect(preview).toContain('## SESSION INTENT')
  expect(preview).toContain('src/download.py')
  expect(preview).not.toContain('<primary_objective>')
  expect.assert(prompt.startsWith('<role>'))
})
