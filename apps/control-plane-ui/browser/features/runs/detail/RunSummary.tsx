import type React from 'react'
import { Group, Text, Title } from '@mantine/core'
import type { Run } from '../api.js'
import { useMessages } from '../../../shared/i18n.js'
import { CopyAction } from '../../../shared/CopyAction.js'
import { ExplainedCode } from './ExplainedCode.js'
import { PlatformMark } from '../PlatformMark.js'
import {
  PreparationStatus,
  ExecutionStatus,
  PublicationStatus
} from '../status.js'
import { workflowLabel } from '../format.js'

export function RunSummary({ run }: { run: Run }): React.JSX.Element {
  const t = useMessages()
  return (
    <div className="run-heading">
      <Group gap="xs" align="center" wrap="nowrap">
        <Title order={1} className="run-id" ff="monospace">
          {run.run_id}
        </Title>
        <CopyAction
          value={run.run_id}
          name={t('copyRunId')}
          copiedName={t('runIdCopied')}
        />
      </Group>
      <div className="run-summary-grid">
        <div className="run-summary-item">
          <Group gap={6} align="baseline" wrap="nowrap">
            <Text c="var(--muted)" size="xs">
              {t('workflow')}
            </Text>
            <Text size="sm">{workflowLabel(run.workflow, t)}</Text>
          </Group>
        </div>
        <div className="run-summary-item">
          {/* Text-only pairs use baseline alignment, but PlatformMark starts with an
                    inline SVG. Baseline-aligning that flex item uses the SVG box as the
                    reference and visibly lifts both the icon and platform name. */}
          <Group gap={6} align="center" wrap="nowrap">
            <Text c="var(--muted)" size="xs">
              {t('platform')}
            </Text>
            <PlatformMark
              platform={run.source_platform}
              githubLabel={t('platformGithub')}
              gitlabLabel={t('platformGitlab')}
              unknownLabel={t('platformUnknown')}
              size="sm"
            />
          </Group>
        </div>
        <div className="run-summary-item run-summary-integration">
          <Group gap={6} align="baseline" wrap="nowrap">
            <Text c="var(--muted)" size="xs">
              {t('integrationInstance')}
            </Text>
            <Text
              size="sm"
              ff="monospace"
              className="integration-id"
              title={run.connector_id}
            >
              {run.connector_id}
            </Text>
          </Group>
        </div>
        <div className="run-summary-item">
          <Group gap={6} align="baseline" wrap="nowrap">
            <Text c="var(--muted)" size="xs">
              {t('preparation')}
            </Text>
            <PreparationStatus preparation={run.preparation} />
          </Group>
        </div>
        <div className="run-summary-item">
          <Group gap={6} align="baseline" wrap="nowrap">
            <Text c="var(--muted)" size="xs">
              {t('execution')}
            </Text>
            <ExecutionStatus status={run.execution.status} />
          </Group>
        </div>
        <div className="run-summary-item">
          <Group gap={6} align="baseline" wrap="nowrap">
            <Text c="var(--muted)" size="xs">
              {t('publication')}
            </Text>
            <PublicationStatus status={run.publication.status} />
          </Group>
        </div>
        {run.failure_code && (
          <div className="run-summary-failure">
            {/* `baseline` keeps the label and monospace code visually aligned. */}
            <Group gap={6} wrap="wrap" align="baseline">
              <Text c="var(--muted)" size="xs">
                {t('failureCode')}:
              </Text>
              <ExplainedCode code={run.failure_code} size="xs" />
            </Group>
          </div>
        )}
      </div>
    </div>
  )
}
