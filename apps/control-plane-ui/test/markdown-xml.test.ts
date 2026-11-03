import { transcriptCorpus } from './contract-fixtures.js'
import assert from 'node:assert/strict'
import test from 'node:test'
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
    assert.equal(markdownWithoutXmlTags(source), expected)
  })
}

test('the recorded summarization prompt keeps its instructions and Markdown sections', () => {
  const raw = transcriptCorpus('summarization.jsonl')
  const events = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const prompt = events.find(
    (event) =>
      event.event === 'message' &&
      event.metadata?.lc_source === 'summarization' &&
      event.message.role === 'user'
  ).message.content as string
  const preview = markdownWithoutXmlTags(prompt)
  assert.ok(preview.includes('Context Extraction Assistant'))
  assert.ok(preview.includes('## SESSION INTENT'))
  assert.ok(preview.includes('src/download.py'))
  assert.ok(!preview.includes('<primary_objective>'))
  assert.ok(prompt.startsWith('<role>'))
})
