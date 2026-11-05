import type React from 'react'
import {
  Anchor,
  Badge,
  Group,
  Paper,
  Text,
  Timeline,
  Title
} from '@mantine/core'
import { IconArrowUpRight, IconClock } from '@tabler/icons-react'
import type { PublicationStep, Run, RunEvent } from '../api.js'
import { formatDate, useLanguage, useMessages } from '../../../shared/i18n.js'
import { ICON_SIZE } from '../../../shared/design.js'
import { RunTransitions } from './RunTransitions.js'
import { RunArtifact } from './RunArtifact.js'
import { RunNotice } from './RunNotice.js'
import { ExplainedCode } from './ExplainedCode.js'
import { ExecutionStatistics } from './ExecutionStatistics.js'
import {
  executionStatusLabel,
  executionTone,
  preparationStateLabel,
  preparationTone,
  publicationStatusColor,
  publicationStatusLabel,
  publicationTone,
  statusBullet,
  statusToneColor
} from '../status.js'
import {
  failureCodeLabel,
  formatDuration,
  phaseElapsed,
  observationAgeMs,
  isObservationStale,
  safeExternalUrl
} from '../format.js'

export function RunProgress({
  run,
  steps,
  events
}: {
  run: Run
  steps: PublicationStep[]
  events: RunEvent[]
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const publicationOutcomes = steps.filter(
    (step) =>
      step.status !== 'succeeded' ||
      safeExternalUrl(step.remote_object_url) !== undefined
  )
  const publicationIndex = 3
  const timelineActive =
    run.publication.status === 'pending'
      ? publicationIndex - 1
      : publicationIndex
  // A publication timestamp only exists once the phase has begun: `publication.started_at`
  // is written on the first claim and `publication.finished_at` when it reaches a terminal
  // state. A run that is still `pending`, or whose publication was ruled out as `skipped`,
  // never started, so it has no such moment to present.
  //
  // This asks the timestamp rather than the status on purpose: a status list has to be
  // updated whenever the contract gains a state, and a forgotten entry would silently hide a
  // real publication. `started_at` is exactly the fact being reported.
  const publishedStart = run.publication.started_at ?? null
  return (
    <Paper
      component="section"
      withBorder
      radius="sm"
      p="md"
      className="run-progress-panel"
    >
      <Title order={2} mb="lg">
        {t('runProgress')}
      </Title>
      <Timeline
        active={timelineActive}
        bulletSize={24}
        lineWidth={2}
        className="run-progress-timeline"
      >
        <Timeline.Item
          bullet={<IconClock size={ICON_SIZE.sm} />}
          title={t('created')}
        >
          <Text c="var(--muted)" size="sm">
            {formatDate(run.created_at, language)}
          </Text>
        </Timeline.Item>
        <Timeline.Item
          bullet={statusBullet(preparationTone(run.preparation))}
          color={statusToneColor(preparationTone(run.preparation))}
          title={<Text fw={500}>{t('preparation')}</Text>}
        >
          {/* A pending preparation has not begun, so there is no timestamp to show and
                      nothing to time. `started_at` is the phase start and `finished_at` its end;
                      `updated_at` also moves on claim heartbeats and input checkpoints and so
                      cannot time the phase. */}
          <Text c="var(--muted)" size="sm">
            {run.preparation.started_at === null
              ? preparationStateLabel(run.preparation.status, t)
              : formatDate(run.preparation.started_at, language)}
            {run.preparation.started_at !== null && (
              <>
                {' · '}
                {phaseElapsed(
                  run.preparation.started_at,
                  run.preparation.finished_at,
                  t
                )}
              </>
            )}
            {' · '}
            {t('preparationAttempts')}: {run.preparation.attempt_count}
          </Text>
          {run.notices
            .filter((notice) => notice.axis === 'preparation')
            .map((notice) => (
              <RunNotice key={notice.notice_id} notice={notice} />
            ))}
        </Timeline.Item>
        <Timeline.Item
          bullet={statusBullet(executionTone(run.execution.status))}
          color={statusToneColor(executionTone(run.execution.status))}
          title={<Text fw={500}>{t('execution')}</Text>}
        >
          {run.execution.started_at === null ? (
            // Execution has not begun: either preparation has not handed the input to the
            // Execution API yet (nothing to time), or it never will because preparation failed
            // and the axis was concluded as `skipped`. The latter has an end without a
            // start, so report when it was concluded rather than a duration it never had.
            <Text c="var(--muted)" size="sm">
              {executionStatusLabel(run.execution.status, t)}
              {run.execution.finished_at !== null &&
                ` · ${formatDate(run.execution.finished_at, language)}`}
            </Text>
          ) : (
            <Text c="var(--muted)" size="sm">
              {formatDate(run.execution.started_at, language)} ·{' '}
              {phaseElapsed(
                run.execution.started_at,
                // The phase end is its own field, not the observation heartbeat: the two
                // agree for now because polling stops at a terminal state, but only
                // `execution_finished_at` promises it. `skipped` has an end without ever
                // having been submitted, so it takes the other branch above.
                run.execution.finished_at,
                t
              )}
            </Text>
          )}
          {observationAgeMs(run) !== null && (
            <Text
              c={isObservationStale(run) ? 'yellow' : 'var(--muted)'}
              size="xs"
              mt={2}
            >
              {isObservationStale(run) && '⚠ '}
              {t('observedAgo')}:{' '}
              {formatDuration(observationAgeMs(run) ?? 0, t)}
              {isObservationStale(run) && ` · ${t('observationStale')}`}
            </Text>
          )}
          {run.notices
            .filter((notice) => notice.axis === 'execution')
            .map((notice) => (
              <RunNotice key={notice.notice_id} notice={notice} />
            ))}
          {run.artifact_storage !== null && (
            <div className="artifact-section">
              <RunArtifact storage={run.artifact_storage} runId={run.run_id} />
            </div>
          )}
          {run.execution.started_at !== null && (
            <ExecutionStatistics
              statistics={run.execution_statistics}
              workflow={run.workflow}
            />
          )}
        </Timeline.Item>
        <Timeline.Item
          bullet={statusBullet(publicationTone(run.publication.status))}
          color={statusToneColor(publicationTone(run.publication.status))}
          title={<Text fw={500}>{t('publication')}</Text>}
        >
          <div className="publication-summary">
            {publishedStart !== null && (
              <Text c="var(--muted)" size="sm">
                {/* The publication phase starts when the work is first claimed, not
                            when execution ended: the gap between the two is the coordinator's
                            polling wait and is not publishing time. The guard above proves the
                            start exists, and `finished_at` is present exactly for terminal
                            states, so neither is papered over with a fallback. */}
                {formatDate(
                  run.publication.finished_at ?? publishedStart,
                  language
                )}{' '}
                · {phaseElapsed(publishedStart, run.publication.finished_at, t)}
              </Text>
            )}
          </div>
          {publicationOutcomes.length > 0 && (
            <div className="delivery-list">
              {publicationOutcomes.map((step) => {
                const externalUrl = safeExternalUrl(step.remote_object_url)
                const succeeded = step.status === 'succeeded'
                const failure = step.failure_code
                  ? failureCodeLabel(step.failure_code, t)
                  : null
                // Coordination-owned codes have stable localized explanations. Connector
                // messages remain the fallback because their open-ended codes cannot be
                // translated without inventing meaning the console does not own.
                const failureMessage =
                  failure?.explanation ?? step.failure_message
                return (
                  <div className="delivery-item" key={step.step_key}>
                    {/* Identity on one line: the step's own key belongs beside its
                                status, not stranded on a line of its own. */}
                    <div className="delivery-main">
                      <Badge
                        variant="light"
                        color={publicationStatusColor(step.status)}
                      >
                        {publicationStatusLabel(step.status, t)}
                      </Badge>
                      <code className="delivery-step-key">{step.step_key}</code>
                    </div>
                    {externalUrl && (
                      <Anchor
                        component="a"
                        href={externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        size="sm"
                        className="delivery-link"
                      >
                        {t('openExternalLink')}
                        <IconArrowUpRight
                          size={ICON_SIZE.sm}
                          aria-hidden="true"
                        />
                      </Anchor>
                    )}
                    {!succeeded &&
                      (step.failure_message ||
                        step.failure_code ||
                        step.attempt_count > 0) && (
                        <div className="delivery-error">
                          {failureMessage && (
                            <Text size="sm">{failureMessage}</Text>
                          )}
                          <Group gap="sm">
                            {step.failure_code && (
                              <ExplainedCode
                                code={step.failure_code}
                                tone="neutral"
                              />
                            )}
                            {step.attempt_count > 0 && (
                              <Text c="dimmed" size="xs">
                                {t('publicationAttempts')}: {step.attempt_count}
                              </Text>
                            )}
                          </Group>
                        </div>
                      )}
                  </div>
                )
              })}
            </div>
          )}
          {run.notices
            .filter((notice) => notice.axis === 'publication')
            .map((notice) => (
              <RunNotice key={notice.notice_id} notice={notice} />
            ))}
        </Timeline.Item>
      </Timeline>
      <RunTransitions key={run.run_id} run={run} events={events} />
    </Paper>
  )
}
