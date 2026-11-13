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
  const scrollPosition = React.useRef(0)
  const uploadGeneration = React.useRef(0)
  const [generation, setGeneration] = React.useState(0)
  React.useLayoutEffect(() => {
    const restore = requestAnimationFrame(() =>
      window.scrollTo(0, scrollPosition.current)
    )
    const remember = (): void => {
      scrollPosition.current = window.scrollY
    }
    window.addEventListener('scroll', remember, { passive: true })
    return (): void => {
      cancelAnimationFrame(restore)
      window.removeEventListener('scroll', remember)
    }
  }, [])
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
    const attempt = ++uploadGeneration.current
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer()
      )
      if (attempt !== uploadGeneration.current) return
      setFilename(file.name)
      setInput(content)
      render(content)
    } catch {
      if (attempt !== uploadGeneration.current) return
      setEvents([])
      setError(t('viewerParseFailed'))
      setInputOpened(true)
    }
  }
  return (
    <Container size="lg" py="xl">
      <Group justify="space-between" mb="lg">
        <Title order={1}>{t('viewer')}</Title>
        {(input || filename || error) && (
          <Button
            variant="default"
            onClick={() => {
              uploadGeneration.current += 1
              setInput('')
              setFilename('')
              setEvents([])
              setError('')
              setInputOpened(true)
              setGeneration((value) => value + 1)
              window.scrollTo(0, 0)
            }}
          >
            {t('clearViewer')}
          </Button>
        )}
      </Group>
      <Paper withBorder p="md" mb="xl" className="viewer-input">
        {events.length > 0 && (
          <Group
            justify="space-between"
            gap="sm"
            className="viewer-input-summary"
          >
            <div className="viewer-input-identity">
              <Text size="sm" fw={600}>
                {t('trajectoryMessageCount', {
                  count: String(
                    events.filter((event) => event.event === 'message').length
                  )
                })}
              </Text>
              {filename && (
                <Text className="viewer-filename" size="xs" c="var(--muted)">
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
            <Text size="sm" c="var(--muted)" mb="sm">
              {t('viewerInputHelp')}
            </Text>
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
                  key={generation}
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
                  <Text className="viewer-filename" size="sm" c="var(--muted)">
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
          <TrajectoryTimeline key={generation} events={events} />
        </Stack>
      )}
    </Container>
  )
}
