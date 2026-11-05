import type React from 'react'
import { Link } from 'react-router-dom'
import { Group, Paper, Table, Text, Tooltip } from '@mantine/core'
import type { Run } from '../api.js'
import { formatDate, useLanguage, useMessages } from '../../../shared/i18n.js'
import { CopyAction } from '../../../shared/CopyAction.js'
import {
  ExecutionStatus,
  PreparationStatus,
  PublicationStatus
} from '../status.js'
import {
  abbreviate,
  formatDuration,
  lastActivity,
  workflowLabel
} from '../format.js'
import { PlatformMark } from '../PlatformMark.js'

export function RunsTable({
  runs,
  listSearch
}: {
  runs: Run[]
  listSearch: string
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  return (
    <Paper withBorder radius="md" className="table-wrap">
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('run')}</Table.Th>
            <Table.Th>{t('workflow')}</Table.Th>
            <Table.Th>{t('platform')}</Table.Th>
            <Table.Th>{t('preparation')}</Table.Th>
            <Table.Th>{t('execution')}</Table.Th>
            <Table.Th>{t('publication')}</Table.Th>
            <Table.Th>{t('lastActivity')}</Table.Th>
            <Table.Th>{t('failureCode')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((run) => (
            <Table.Tr key={run.run_id}>
              <Table.Td data-label={t('run')}>
                <Group gap={4} align="center" wrap="nowrap">
                  <Tooltip label={run.run_id}>
                    <Link
                      // A hex id reads far better in a monospaced face: proportional
                      // digits make `0`/`O` and `1`/`l` ambiguous at 12px.
                      style={{
                        fontFamily: 'var(--mantine-font-family-monospace)',
                        whiteSpace: 'nowrap'
                      }}
                      to={`/runs/${encodeURIComponent(run.run_id)}`}
                      state={{ listSearch }}
                    >
                      {abbreviate(run.run_id, 8, 4)}
                    </Link>
                  </Tooltip>
                  <span className="row-action">
                    <CopyAction
                      value={run.run_id}
                      name={t('copyRunId')}
                      copiedName={t('runIdCopied')}
                    />
                  </span>
                </Group>
              </Table.Td>
              <Table.Td data-label={t('workflow')}>
                {workflowLabel(run.workflow, t)}
              </Table.Td>
              <Table.Td data-label={t('platform')}>
                <PlatformMark
                  platform={run.source_platform}
                  githubLabel={t('platformGithub')}
                  gitlabLabel={t('platformGitlab')}
                  unknownLabel={t('platformUnknown')}
                  compactOnNarrow
                />
              </Table.Td>
              <Table.Td data-label={t('preparation')}>
                <PreparationStatus preparation={run.preparation} />
              </Table.Td>
              <Table.Td data-label={t('execution')}>
                <ExecutionStatus status={run.execution.status} />
              </Table.Td>
              <Table.Td data-label={t('publication')}>
                <PublicationStatus status={run.publication.status} />
              </Table.Td>
              <Table.Td data-label={t('lastActivity')}>
                <Tooltip label={formatDate(lastActivity(run), language)}>
                  <span>
                    {formatDuration(
                      Date.now() - Date.parse(lastActivity(run)),
                      t
                    )}{' '}
                    {t('ago')}
                  </span>
                </Tooltip>
              </Table.Td>
              <Table.Td data-label={t('failureCode')}>
                {run.failure_code && (
                  <Text c="var(--failure-text)" size="xs" ff="monospace">
                    {run.failure_code}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  )
}
