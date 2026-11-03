import React from 'react'
import { readTrajectoryJsonl } from '../../../shared/trajectory-events.js'
import {
  Alert,
  Button,
  Collapse,
  Container,
  FileButton,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  Title
} from '@mantine/core'
import {
  IconChevronDown,
  IconEdit,
  IconPlayerPlay,
  IconUpload
} from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { TrajectoryTimeline } from '../trajectory/TrajectoryTimeline.js'
import type { TrajectoryEvent } from '../trajectory/trajectory-model.js'
import { ICON_SIZE } from '../../shared/design.js'

/** Read trajectory JSONL. */
export function parseViewerInput(input: string): TrajectoryEvent[] {
  const events = readTrajectoryJsonl(input)
  if (!events.length) throw new Error('empty_input')
  return events
}

export function Viewer(): React.JSX.Element {
  const t = useMessages()
  const [input, setInput] = React.useState('')
  const [filename, setFilename] = React.useState('')
  const [events, setEvents] = React.useState<TrajectoryEvent[]>([])
  const [error, setError] = React.useState('')
  const [inputOpened, setInputOpened] = React.useState(true)
  const render = (content = input): void => {
    try {
      setEvents(parseViewerInput(content))
      setError('')
      setInputOpened(false)
    } catch {
      setEvents([])
      setError(t('viewerParseFailed'))
      setInputOpened(true)
    }
  }
  const upload = async (file: File | null): Promise<void> => {
    if (!file) return
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer()
      )
      setFilename(file.name)
      setInput(content)
      render(content)
    } catch {
      setEvents([])
      setError(t('viewerParseFailed'))
      setInputOpened(true)
    }
  }
  return (
    <Container size="lg" py="xl">
      <Title order={1} mb="lg">
        {t('viewer')}
      </Title>
      <Paper withBorder p="md" mb="xl" className="viewer-input">
        {events.length > 0 && (
          <Group
            justify="space-between"
            gap="sm"
            className="viewer-input-summary"
          >
            <div>
              <Text size="sm" fw={600}>
                {t('trajectoryMessageCount').replace(
                  '{count}',
                  String(
                    events.filter((event) => event.event === 'message').length
                  )
                )}
              </Text>
              {filename && (
                <Text size="xs" c="dimmed">
                  {filename}
                </Text>
              )}
            </div>
            <Button
              variant="subtle"
              size="compact-sm"
              leftSection={<IconEdit size={ICON_SIZE.sm} />}
              rightSection={
                <IconChevronDown
                  size={ICON_SIZE.sm}
                  style={{
                    transform: inputOpened ? 'rotate(180deg)' : undefined,
                    transition: 'transform 120ms ease'
                  }}
                />
              }
              aria-expanded={inputOpened}
              onClick={() => setInputOpened((opened) => !opened)}
            >
              {t('viewerEditInput')}
            </Button>
          </Group>
        )}
        <Collapse expanded={inputOpened}>
          <div className="viewer-input-editor">
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
                  accept=".jsonl,application/x-ndjson,text/plain"
                >
                  {(props) => (
                    <Button
                      {...props}
                      variant="default"
                      leftSection={<IconUpload size={ICON_SIZE.md} />}
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
                leftSection={<IconPlayerPlay size={ICON_SIZE.md} />}
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
          </div>
        </Collapse>
      </Paper>
      {events.length > 0 && (
        <Stack gap="md">
          <TrajectoryTimeline events={events} />
        </Stack>
      )}
    </Container>
  )
}
