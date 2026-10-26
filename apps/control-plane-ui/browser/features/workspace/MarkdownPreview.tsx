import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownPreview({
  source,
  onOpenLink
}: {
  source: string
  onOpenLink: (href: string) => boolean
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              if (href !== undefined && onOpenLink(href)) event.preventDefault()
            }}
          >
            {children}
          </a>
        )
      }}
    >
      {source}
    </ReactMarkdown>
  )
}
