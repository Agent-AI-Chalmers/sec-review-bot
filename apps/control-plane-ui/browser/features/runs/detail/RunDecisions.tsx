import React from 'react'
import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { Run, RunEvent } from '../api.js'
import { useMessages } from '../../../shared/i18n.js'
import { ICON_SIZE } from '../../../shared/design.js'
import { AdminRunActionDialog } from './AdminRunActionDialog.js'
import { canResumeRun, failureCodeLabel, formatDuration } from '../format.js'

export function RunDecisions({
  run,
  events,
  now,
  onDone
}: {
  run: Run
  events: RunEvent[]
  now: number
  onDone: () => Promise<void>
}): React.JSX.Element {
  const t = useMessages()
  const [abandoning, setAbandoning] = React.useState(false)
  const [resuming, setResuming] = React.useState(false)
  const [givingUp, setGivingUp] = React.useState(false)
  // What the reason code means, looked up once. The banner names the conflict only through this
  // sentence, so an unrecognised code renders plainly instead of guessing at a cause.
  const disconnectExplanation = run.preparation.disconnect_reason
    ? failureCodeLabel(run.preparation.disconnect_reason, t).explanation
    : null
  // Abandoning stops an execution that is still moving, and leaves a finished one alone. Saying
  // so unconditionally would describe a stop that cannot happen - a run whose task already
  // completed has nothing left to stop.
  const executionStillMovable = ['queued', 'running', 'uncertain'].includes(
    run.execution.status
  )
  // Which axis parked this run, so the banner's wording follows one value instead of a chain of
  // ternaries that silently falls back to the preparation case for anything new. Preparation wins
  // when present because it always explains the others: it parks only by contradicting execution.
  const parkedAxis: 'preparation' | 'execution' | 'publication' | null =
    run.preparation.status === 'disconnected'
      ? 'preparation'
      : run.execution.status === 'disconnected'
        ? 'execution'
        : run.publication.status === 'disconnected'
          ? 'publication'
          : null
  const parkedAt: string | null =
    parkedAxis === null
      ? null
      : ((): string | null => {
          let latest: string | null = null
          for (const event of events) {
            if (event.axis !== parkedAxis || event.to_status !== 'disconnected')
              continue
            if (
              latest === null ||
              Date.parse(event.occurred_at) > Date.parse(latest)
            )
              latest = event.occurred_at
          }
          return (
            latest ??
            (parkedAxis === 'preparation'
              ? run.preparation.updated_at
              : parkedAxis === 'execution'
                ? run.execution.updated_at
                : run.publication.updated_at)
          )
        })()
  return (
    <>
      <AdminRunActionDialog
        runId={run.run_id}
        config={{
          action: 'abandon',
          title: 'abandonTitle',
          explainer: 'abandonExplainer',
          ...(run.execution.status === 'succeeded' ||
          run.execution.status === 'failed'
            ? { extraExplainer: t('abandonExplainerKeepsResult') }
            : {}),
          confirmLabel: 'abandonConfirm',
          confirmColor: 'red',
          requiresReason: true
        }}
        opened={abandoning}
        onClose={() => setAbandoning(false)}
        onDone={async () => {
          setAbandoning(false)
          await onDone()
        }}
      />
      <AdminRunActionDialog
        runId={run.run_id}
        config={{
          action: 'resume',
          title: 'resumeTitle',
          explainer: 'resumeExplainer',
          confirmLabel: 'resumeConfirm',
          requiresReason: false,
          testId: 'resume-run-confirm'
        }}
        opened={resuming}
        onClose={() => setResuming(false)}
        onDone={async () => {
          setResuming(false)
          await onDone()
        }}
      />
      <AdminRunActionDialog
        runId={run.run_id}
        config={{
          action: 'give-up',
          title: 'giveUpTitle',
          explainer: 'giveUpExplainer',
          confirmLabel: 'giveUpConfirm',
          confirmColor: 'orange',
          requiresReason: true,
          testId: 'give-up-confirm'
        }}
        opened={givingUp}
        onClose={() => setGivingUp(false)}
        onDone={async () => {
          setGivingUp(false)
          await onDone()
        }}
      />
      {/* Every axis that can park must reach this banner, or a parked run shows no
                decision at all - the queue names it and the detail page offers nothing. */}
      {(run.preparation.status === 'disconnected' ||
        run.execution.status === 'disconnected' ||
        run.publication.status === 'disconnected') && (
        <Alert
          // A run the system refused to conclude. `Alert` rather than `Paper`: this is a
          // call to act, and it must not look like another content card on the page.
          color="orange"
          variant="light"
          radius="md"
          p="lg"
          title={
            <Group justify="space-between" align="center" wrap="wrap" gap="xs">
              <Group gap="xs" align="center" wrap="nowrap">
                <IconAlertTriangle size={ICON_SIZE.md} aria-hidden />
                <span>
                  {t(
                    parkedAxis === 'preparation'
                      ? 'blockedRunTitle'
                      : parkedAxis === 'execution'
                        ? 'disconnectedExecutionTitle'
                        : 'disconnectedPublicationTitle'
                  )}
                </span>
              </Group>
              {parkedAt !== null && (
                <Text size="xs" c="dimmed">
                  {t('parkedAge').replace(
                    '{duration}',
                    formatDuration(Math.max(0, now - Date.parse(parkedAt)), t)
                  )}
                </Text>
              )}
            </Group>
          }
          className="blocked-run"
          data-testid="blocked-run"
        >
          <Stack gap="sm">
            {/* The button centres on the explanation alone. The code sits outside this
                      row: it is a reference value, and letting it lengthen the row would drag
                      the button below the middle of the sentence it belongs to. */}
            <Group
              justify="space-between"
              align="center"
              gap="lg"
              wrap="nowrap"
              className="blocked-run-content"
            >
              {/* The two parked states have different causes and different
                        consequences, so the explanation follows the axis that stopped rather
                        than describing the preparation contradiction in both cases. */}
              <Stack gap="xs">
                <Text size="sm" className="blocked-run-body">
                  {t(
                    parkedAxis === 'preparation'
                      ? 'blockedRunBody'
                      : parkedAxis === 'execution'
                        ? 'disconnectedExecutionBody'
                        : 'disconnectedPublicationBody'
                  )}
                </Text>
                {/* What each decision actually does, stated before it is taken rather
                          than discovered afterwards. The two buttons look alike, and only the
                          consequence tells them apart. A resume is only described when the
                          server would accept it: an unusable decision is not offered, and its
                          description is not shown either. */}
                {canResumeRun(run) && (
                  <Text size="xs" c="dimmed">
                    {t(
                      parkedAxis === 'preparation'
                        ? 'blockedOutcomeResume'
                        : parkedAxis === 'execution'
                          ? 'disconnectedExecutionOutcomeResume'
                          : 'disconnectedPublicationOutcomeResume'
                    )}
                  </Text>
                )}
                {!canResumeRun(run) && (
                  <Text size="xs" c="dimmed">
                    {t('blockedNoResumeReason')}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {t(
                    parkedAxis === 'preparation'
                      ? 'blockedOutcomeAbandon'
                      : parkedAxis === 'execution'
                        ? 'disconnectedExecutionOutcomeGiveUp'
                        : 'disconnectedPublicationOutcomeGiveUp'
                  )}
                  {/* Only when there is something to stop. */}
                  {parkedAxis === 'preparation' &&
                    executionStillMovable &&
                    ` ${t('blockedOutcomeAbandonRemoteExecution')}`}
                </Text>
              </Stack>
              {/* Resuming is offered first: it keeps the run alive, while the other
                        decision stops waiting for it. The labels differ by axis because the
                        decisions do: a contradicted run is abandoned, while an unknowable
                        outcome is given up on, which claims nothing about what happened.
                        The group is non-shrinking as a unit, so no button collapses when the
                        explanation fills the row. */}
              <Group gap="xs" wrap="nowrap" className="blocked-run-action">
                {canResumeRun(run) && (
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => setResuming(true)}
                    data-testid="resume-run"
                  >
                    {t('resumeRun')}
                  </Button>
                )}
                {/* Two different decisions reach the same server operation, and the
                          label follows the axis: a contradicted run is abandoned, while an
                          unknowable outcome is given up on. */}
                {run.preparation.status === 'disconnected' ? (
                  <Button
                    color="red"
                    variant="filled"
                    size="xs"
                    onClick={() => setAbandoning(true)}
                    data-testid="abandon-run"
                    className="blocked-run-action"
                  >
                    {t('abandonRun')}
                  </Button>
                ) : (
                  <Button
                    color="red"
                    variant="filled"
                    size="xs"
                    onClick={() => setGivingUp(true)}
                    data-testid="give-up-run"
                    className="blocked-run-action"
                  >
                    {t('giveUpRun')}
                  </Button>
                )}
              </Group>
            </Group>
            {/* The banner states only that the run stopped and why a decision is needed;
                      this is where the specific conflict is named. It is shown, not hidden
                      behind a tooltip: the banner points the reader here, and a tooltip would
                      make that pointer lead nowhere unless guessed at. A code the console does
                      not know still renders as the bare code. */}
            {run.preparation.disconnect_reason !== null && (
              <Stack gap={4}>
                <Text size="xs" ff="monospace" c="dimmed">
                  {run.preparation.disconnect_reason}
                </Text>
                {disconnectExplanation !== null && (
                  <Text size="xs" c="dimmed">
                    {disconnectExplanation}
                  </Text>
                )}
              </Stack>
            )}
          </Stack>
        </Alert>
      )}
    </>
  )
}
