import React from 'react'
import { Alert, Code, Text } from '@mantine/core'
import { JSONTree } from 'react-json-tree'

import { useMessages } from '../../shared/i18n.js'

const treeTheme = {
  scheme: 'mantine',
  author: 'Control Plane UI',
  base00: 'var(--mantine-color-body)',
  base01: 'var(--mantine-color-default-hover)',
  base02: 'var(--border)',
  base03: 'var(--mantine-color-dimmed)',
  base04: 'var(--mantine-color-dimmed)',
  base05: 'var(--mantine-color-text)',
  base06: 'var(--mantine-color-text)',
  base07: 'var(--mantine-color-text)',
  base08: 'light-dark(var(--mantine-color-red-8), var(--mantine-color-red-4))',
  base09:
    'light-dark(var(--mantine-color-orange-8), var(--mantine-color-orange-4))',
  base0A:
    'light-dark(var(--mantine-color-yellow-8), var(--mantine-color-yellow-4))',
  base0B:
    'light-dark(var(--mantine-color-green-8), var(--mantine-color-green-4))',
  base0C:
    'light-dark(var(--mantine-color-cyan-8), var(--mantine-color-cyan-4))',
  base0D:
    'light-dark(var(--mantine-color-blue-8), var(--mantine-color-blue-4))',
  base0E:
    'light-dark(var(--mantine-color-grape-8), var(--mantine-color-grape-4))',
  base0F: 'light-dark(var(--mantine-color-pink-8), var(--mantine-color-pink-4))'
}

function JsonTree({ value }: { value: unknown }): React.JSX.Element {
  return (
    <JSONTree
      data={value}
      theme={treeTheme}
      invertTheme={false}
      hideRoot
      shouldExpandNodeInitially={(_keyPath, _data, level) => level < 2}
    />
  )
}

function JsonLine({
  lineNumber,
  recordNumber,
  value,
  raw
}: {
  lineNumber: number
  recordNumber: number
  value?: unknown
  raw: string
}): React.JSX.Element {
  const t = useMessages()
  const [opened, setOpened] = React.useState(recordNumber <= 3)
  return (
    <details
      className="jsonl-record"
      open={opened}
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>
        {t('jsonlRecord')
          .replace('{record}', String(recordNumber))
          .replace('{line}', String(lineNumber))}
        {value === undefined && (
          <Text component="span" c="red" size="xs" ml="xs">
            {t('jsonlInvalidRecord')}
          </Text>
        )}
      </summary>
      {opened &&
        (value === undefined ? (
          <Code block>{raw}</Code>
        ) : (
          <JsonTree value={value} />
        ))}
    </details>
  )
}

export function JsonFilePreview({
  content,
  jsonLines = false
}: {
  content: string
  jsonLines?: boolean
}): React.JSX.Element {
  const t = useMessages()
  if (!jsonLines) {
    try {
      return <JsonTree value={JSON.parse(content)} />
    } catch {
      return <Alert color="red">{t('jsonInvalid')}</Alert>
    }
  }

  const records = content
    .split('\n')
    .map((raw, index) => ({ raw, lineNumber: index + 1 }))
    .filter(({ raw }) => raw.trim() !== '')
    .map((record, index) => {
      try {
        return {
          ...record,
          recordNumber: index + 1,
          value: JSON.parse(record.raw)
        }
      } catch {
        return { ...record, recordNumber: index + 1, value: undefined }
      }
    })
  return (
    <div className="jsonl-preview">
      {records.map((record) => (
        <JsonLine key={record.lineNumber} {...record} />
      ))}
    </div>
  )
}
