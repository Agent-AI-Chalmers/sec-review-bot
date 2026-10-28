import React from 'react'

import {
  Button,
  Collapse,
  Group,
  Pagination,
  SegmentedControl,
  Stack,
  Text,
  Tooltip
} from '@mantine/core'
import { IconChevronDown, IconSitemap } from '@tabler/icons-react'

import type { Run, RunEvent } from './api.js'
import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import { axisLabel } from './status.js'
import { useNow } from '../../shared/useNow.js'
import { type StateAxis } from './state-machines.generated.js'
import { failureCodeLabel, formatDuration } from './format.js'
import {
  TRANSITIONS_PAGE_SIZE,
  actualTransitions,
  diagrammedMachines,
  latestTransitionAxis,
  machineTitle,
  stateLabelForEvent,
  transitionDuration,
  transitionExplanation
} from './transitions.js'
import { StateMachineDiagram } from './StateMachineDiagram.js'

const FIT_PREFERENCE_KEY = 'state-machine-fit'

function initialFit(): boolean {
  try {
    return localStorage.getItem(FIT_PREFERENCE_KEY) !== 'actual'
  } catch {
    return true
  }
}

function TransitionReason({ code }: { code: string }): React.JSX.Element {
  const t = useMessages()
  const { explanation } = failureCodeLabel(code, t)
  const label = (
    <Text component="span" size="xs" ff="monospace" c="dimmed">
      {code}
    </Text>
  )
  if (explanation === null) return label
  return (
    <Tooltip
      label={explanation}
      multiline
      w={360}
      withArrow
      position="bottom-start"
      openDelay={150}
    >
      {label}
    </Tooltip>
  )
}

/**
 * The coordination state machines and the transitions this run actually made. The diagrams stay
 * above as a small reference; the paginated list below is the authoritative history.
 */
export function RunTransitions({
  run,
  events
}: {
  run: Run
  events: RunEvent[]
}): React.JSX.Element | null {
  const t = useMessages()
  const { language } = useLanguage()
  const [opened, setOpened] = React.useState(false)
  const [axis, setAxis] = React.useState<StateAxis>(() =>
    latestTransitionAxis(events)
  )
  const [page, setPage] = React.useState(1)
  const [fit, setFit] = React.useState(initialFit)
  const now = useNow()
  const machines = diagrammedMachines()
  const machine =
    machines.find((candidate) => candidate.axis === axis) ?? machines[0]
  if (machine === undefined) return null
  const transitionEvents = actualTransitions(events)
  const totalPages = Math.max(
    1,
    Math.ceil(transitionEvents.length / TRANSITIONS_PAGE_SIZE)
  )
  const currentPage = Math.min(page, totalPages)
  const visibleEvents = transitionEvents.slice(
    (currentPage - 1) * TRANSITIONS_PAGE_SIZE,
    currentPage * TRANSITIONS_PAGE_SIZE
  )
  return (
    <div className="run-transitions">
      <Button
        variant="subtle"
        size="compact-sm"
        leftSection={<IconSitemap size={16} aria-hidden />}
        rightSection={
          <IconChevronDown
            size={14}
            aria-hidden
            style={{
              transform: opened ? 'rotate(180deg)' : undefined,
              transition: 'transform 120ms ease'
            }}
          />
        }
        aria-expanded={opened}
        className="transitions-entry"
        onClick={() => setOpened((value) => !value)}
      >
        {t('stateMachineTransitions')}
        <span className="transitions-count">{transitionEvents.length}</span>
      </Button>
      <Collapse expanded={opened}>
        <Stack gap="md" className="transitions-body">
          <SegmentedControl
            fullWidth
            value={axis}
            onChange={(value) => setAxis(value as StateAxis)}
            data={machines.map((candidate) => ({
              value: candidate.axis,
              label: machineTitle(candidate, t)
            }))}
          />
          <Text size="xs" c="dimmed">
            {t('stateMachineHint')}
          </Text>
          {!fit && (
            <Text size="xs" c="dimmed">
              {t('stateMachineScrollHint')}
            </Text>
          )}
          <StateMachineDiagram
            machine={machine}
            run={run}
            events={events}
            fit={fit}
          />
          <Group
            justify="space-between"
            align="center"
            wrap="wrap"
            gap="sm"
            className="state-machine-toolbar"
          >
            <Group gap="md" className="state-machine-legend">
              <span className="state-machine-legend-item">
                <span className="state-machine-legend-line is-forward" />
                {t('stateMachineLegendForward')}
              </span>
              <span className="state-machine-legend-item">
                <span className="state-machine-legend-line is-revert" />
                {t('stateMachineLegendRevert')}
              </span>
              <span className="state-machine-legend-item">
                <span className="state-machine-legend-line is-current" />
                {t('stateMachineLegendCurrent')}
              </span>
            </Group>
            <SegmentedControl
              size="xs"
              value={fit ? 'fit' : 'actual'}
              onChange={(value) => {
                const next = value === 'fit'
                setFit(next)
                try {
                  localStorage.setItem(
                    FIT_PREFERENCE_KEY,
                    next ? 'fit' : 'actual'
                  )
                } catch {
                  // Storage can be unavailable in privacy-restricted contexts.
                }
              }}
              data={[
                { value: 'fit', label: t('stateMachineFit') },
                { value: 'actual', label: t('stateMachineActual') }
              ]}
            />
          </Group>
          <div className="transitions-list">
            <Text size="xs" fw={600} c="dimmed">
              {t('stateMachineTransitions')} · {transitionEvents.length}
            </Text>
            {transitionEvents.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('stateMachineNoTransitions')}
              </Text>
            ) : (
              <ul className="run-transition-list">
                {visibleEvents.map((event) => {
                  const explanation = transitionExplanation(event, machines, t)
                  const duration = transitionDuration(
                    event,
                    transitionEvents,
                    run,
                    machines,
                    now
                  )
                  return (
                    <li className="run-transition" key={event.event_id}>
                      <Text size="xs" c="dimmed">
                        {formatDate(event.occurred_at, language)} ·{' '}
                        {axisLabel(event.axis, t)}
                      </Text>
                      <Text size="sm">
                        {stateLabelForEvent(
                          event,
                          machines,
                          event.from_status,
                          t
                        )}{' '}
                        →{' '}
                        {stateLabelForEvent(
                          event,
                          machines,
                          event.to_status,
                          t
                        )}
                      </Text>
                      {explanation !== null && (
                        <Text size="xs" c="dimmed">
                          {explanation}
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        {duration.kind === 'final'
                          ? t('stateFinal')
                          : t('stateDuration').replace(
                              '{duration}',
                              formatDuration(duration.ms, t)
                            )}
                      </Text>
                      {event.reason_code !== null && (
                        <TransitionReason code={event.reason_code} />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {totalPages > 1 && (
              <Pagination
                total={totalPages}
                value={currentPage}
                onChange={setPage}
                size="sm"
              />
            )}
          </div>
        </Stack>
      </Collapse>
    </div>
  )
}
