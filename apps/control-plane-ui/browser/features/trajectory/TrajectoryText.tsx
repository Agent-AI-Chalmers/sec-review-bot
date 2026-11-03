import React from 'react'
import ReactMarkdown from 'react-markdown'
import { Code } from '@mantine/core'
import { markdownWithoutXmlTags } from './markdown-xml.js'
import remarkGfm from 'remark-gfm'

export function HighlightText({
  value,
  query
}: {
  value: string
  query: string
}): React.JSX.Element {
  const needle = query.trim()
  if (!needle) return <>{value}</>
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = value.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={index}>{part}</mark>
        ) : (
          part
        )
      )}
    </>
  )
}

function highlightNode(node: React.ReactNode, query: string): React.ReactNode {
  if (typeof node === 'string')
    return <HighlightText value={node} query={query} />
  if (Array.isArray(node))
    return node.map((item, index) => (
      <React.Fragment key={index}>{highlightNode(item, query)}</React.Fragment>
    ))
  if (React.isValidElement<{ children?: React.ReactNode }>(node))
    return React.cloneElement(
      node,
      undefined,
      highlightNode(node.props.children, query)
    )
  return node
}

export function HighlightedMarkdown({
  children,
  query
}: {
  children: string
  query: string
}): React.JSX.Element {
  const highlight = ({
    children: node
  }: {
    children?: React.ReactNode
  }): React.ReactNode => highlightNode(node, query)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children: node }) => <p>{highlight({ children: node })}</p>,
        li: ({ children: node }) => <li>{highlight({ children: node })}</li>,
        code: ({ children: node }) => (
          <code>{highlight({ children: node })}</code>
        ),
        td: ({ children: node }) => <td>{highlight({ children: node })}</td>,
        th: ({ children: node }) => <th>{highlight({ children: node })}</th>
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

export function TrajectoryText({
  children,
  query,
  mode
}: {
  children: string
  query: string
  mode: string
}): React.JSX.Element {
  const rendered = React.useMemo(
    () => markdownWithoutXmlTags(children),
    [children]
  )
  return (
    <div>
      {mode === 'source' ? (
        <Code block className="trajectory-source">
          <HighlightText value={children} query={query} />
        </Code>
      ) : (
        <div className="memory-markdown memory-markdown-full">
          <HighlightedMarkdown query={query}>{rendered}</HighlightedMarkdown>
        </div>
      )}
    </div>
  )
}
