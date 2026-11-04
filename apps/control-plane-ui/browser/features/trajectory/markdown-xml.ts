import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'

const XML_TAG =
  /<\/?[A-Za-z_][\w.:-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g

function escaped(source: string, offset: number): boolean {
  let count = 0
  while (offset > 0 && source[--offset] === '\\') count += 1
  return count % 2 === 1
}

export function markdownWithoutXmlTags(source: string): string {
  // Mask tags at equal width so Markdown can find code inside XML wrappers.
  // Source offsets still point into the original text, including code examples.
  const masked = source.replace(XML_TAG, (tag: string, offset: number) =>
    escaped(source, offset) ? tag : tag.replace(/\S/g, 'x')
  )
  if (masked === source) return source
  const code: [number, number][] = []

  function visit(node: Nodes): void {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) code.push([start, end])
    }
    if ('children' in node) node.children.forEach(visit)
  }

  visit(fromMarkdown(masked))
  return source.replace(XML_TAG, (tag: string, offset: number) =>
    escaped(source, offset) ||
    code.some(([start, end]) => offset < end && offset + tag.length > start)
      ? tag
      : ''
  )
}
