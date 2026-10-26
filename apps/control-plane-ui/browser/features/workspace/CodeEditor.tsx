import React from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'

export function CodeEditor({
  value,
  onChange,
  ariaLabel,
  language = 'markdown',
  readOnly = false
}: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  language?: 'markdown' | 'json' | 'text'
  readOnly?: boolean
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange

  React.useEffect(() => {
    if (!hostRef.current) return
    const languageExtension: Extension[] =
      language === 'markdown'
        ? [markdown()]
        : language === 'json'
          ? [json()]
          : []
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        basicSetup,
        ...languageExtension,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !readOnly)
            onChangeRef.current(update.state.doc.toString())
        })
      ]
    })
    viewRef.current = view
    return (): void => {
      view.destroy()
      viewRef.current = null
    }
  }, [ariaLabel, language, readOnly])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value }
    })
  }, [value])

  return <div ref={hostRef} className="code-editor" />
}
