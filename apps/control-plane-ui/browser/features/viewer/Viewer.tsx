import React from 'react'
import {
  Alert,
  Button,
  Container,
  FileButton,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  Title
} from '@mantine/core'
import { IconPlayerPlay, IconUpload } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import {
  TranscriptTimeline,
  type TranscriptEvent
} from '../transcript/TranscriptViewer.js'

function messageRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  return value as Record<string, unknown>
}

/** Accept the concrete shapes people actually paste from this repository: transcript JSONL,
 * an event array, `{ events }`, `{ messages }`, or a raw message array. Unlike agent-visual's
 * compatibility parser, this does not evaluate or guess Python repr syntax. */
export function parseViewerInput(input: string): TranscriptEvent[] {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('empty_input')
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    value = trimmed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  const root = messageRecord(value)
  const items = Array.isArray(value)
    ? value
    : Array.isArray(root?.events)
      ? root.events
      : Array.isArray(root?.messages)
        ? root.messages
        : []
  if (items.length === 0) throw new Error('no_messages')
  return items.map((item, index) => {
    const record = messageRecord(item)
    if (record === null) throw new Error('invalid_message')
    if (record.event === 'message') {
      const message = messageRecord(record.message)
      if (!Number.isSafeInteger(record.seq) || message === null)
        throw new Error('invalid_event')
      return {
        seq: record.seq as number,
        event: 'message',
        message
      }
    }
    return { seq: index + 1, event: 'message', message: record }
  })
}

export function Viewer(): React.JSX.Element {
  const t = useMessages()
  const [input, setInput] = React.useState('')
  const [filename, setFilename] = React.useState('')
  const [events, setEvents] = React.useState<TranscriptEvent[]>([])
  const [error, setError] = React.useState('')
  const render = (content = input): void => {
    try {
      setEvents(parseViewerInput(content))
      setError('')
    } catch {
      setEvents([])
      setError(t('viewerParseFailed'))
    }
  }
  const upload = async (file: File | null): Promise<void> => {
    if (!file) return
    const content = await file.text()
    setFilename(file.name)
    setInput(content)
    render(content)
  }
  return (
    <Container size="lg" py="xl">
      <Title order={1} mb="lg">
        {t('viewer')}
      </Title>
      <Paper withBorder p="md" mb="xl" className="viewer-input">
        <Textarea
          placeholder={t('viewerPlaceholder')}
          aria-label={t('viewerPlaceholder')}
          autosize
          minRows={8}
          maxRows={18}
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
        />
        <Group justify="space-between" mt="md">
          <Group gap="sm">
            <FileButton
              onChange={(file) => void upload(file)}
              accept=".json,.jsonl,application/json,text/plain"
            >
              {(props) => (
                <Button
                  {...props}
                  variant="default"
                  leftSection={<IconUpload size={16} />}
                >
                  {t('uploadFile')}
                </Button>
              )}
            </FileButton>
            {filename && (
              <Text size="sm" c="dimmed">
                {filename}
              </Text>
            )}
          </Group>
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            disabled={!input.trim()}
            onClick={() => render()}
          >
            {t('render')}
          </Button>
        </Group>
        {error && (
          <Alert color="red" mt="md">
            {error}
          </Alert>
        )}
      </Paper>
      {events.length > 0 && (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t('transcriptMessageCount').replace(
              '{count}',
              String(events.length)
            )}
          </Text>
          <TranscriptTimeline events={events} />
        </Stack>
      )}
    </Container>
  )
}
