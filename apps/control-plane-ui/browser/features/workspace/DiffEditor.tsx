import React from 'react'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { basicSetup, EditorView } from 'codemirror'

function editorExtensions(language: 'markdown' | 'json' | 'text'): Extension[] {
  const languageExtension =
    language === 'markdown' ? markdown() : language === 'json' ? json() : []
  return [
    basicSetup,
    languageExtension,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping
  ]
}

export function DiffEditor({
  before,
  after,
  mode,
  language,
  beforeLabel,
  afterLabel
}: {
  before: string
  after: string
  mode: 'side-by-side' | 'unified'
  language: 'markdown' | 'json' | 'text'
  beforeLabel: string
  afterLabel: string
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!hostRef.current) return
    if (mode === 'side-by-side') {
      const merge = new MergeView({
        parent: hostRef.current,
        a: {
          doc: before,
          extensions: [
            ...editorExtensions(language),
            EditorView.contentAttributes.of({ 'aria-label': beforeLabel })
          ]
        },
        b: {
          doc: after,
          extensions: [
            ...editorExtensions(language),
            EditorView.contentAttributes.of({ 'aria-label': afterLabel })
          ]
        },
        collapseUnchanged: { margin: 3, minSize: 8 },
        diffConfig: { timeout: 1000 }
      })
      return (): void => merge.destroy()
    }
    const view = new EditorView({
      doc: after,
      parent: hostRef.current,
      extensions: [
        ...editorExtensions(language),
        EditorView.contentAttributes.of({ 'aria-label': afterLabel }),
        unifiedMergeView({
          original: before,
          mergeControls: false,
          allowInlineDiffs: true,
          collapseUnchanged: { margin: 3, minSize: 8 },
          diffConfig: { timeout: 1000 }
        })
      ]
    })
    return (): void => view.destroy()
  }, [after, afterLabel, before, beforeLabel, language, mode])

  return <div ref={hostRef} className="memory-diff-editor" />
}
