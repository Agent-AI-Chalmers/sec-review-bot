import React from 'react'
import { Badge, Button, Code, Group, Modal, Stack, Text } from '@mantine/core'
import { IconFileText } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import type { MaintenanceReport } from './api-types.generated.js'

type Decision = MaintenanceReport['observation_decisions'][number]

const DECISION_LABELS = {
  added: 'decisionAdded',
  merged: 'decisionMerged',
  skipped: 'decisionSkipped',
  conflict: 'decisionConflict'
} as const satisfies Record<Decision['action'], string>

const DECISION_COLORS = {
  added: 'green',
  merged: 'blue',
  skipped: 'gray',
  conflict: 'orange'
} as const satisfies Record<Decision['action'], string>

// Shared by the revision list and graph so both views open the same report.
export function MaintenanceReportButton({
  report
}: {
  report: MaintenanceReport
}): React.JSX.Element {
  const t = useMessages()
  const [opened, setOpened] = React.useState(false)
  return (
    <>
      <Button
        size="xs"
        variant="subtle"
        leftSection={<IconFileText size={ICON_SIZE.sm} />}
        onClick={() => setOpened(true)}
      >
        {t('maintenanceReport')}
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={t('maintenanceReport')}
        size="lg"
        centered
      >
        <MaintenanceReportView report={report} />
      </Modal>
    </>
  )
}

function MaintenanceReportView({
  report
}: {
  report: MaintenanceReport
}): React.JSX.Element {
  const t = useMessages()
  const decisions = report.observation_decisions
  return (
    <Stack gap="md">
      <Text>{report.summary}</Text>
      {decisions.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('noObservationDecisions')}
        </Text>
      ) : (
        <Stack gap="xs" component="ul" className="maintenance-decisions">
          {decisions.map((decision) => (
            <li key={decision.extraction_id} className="maintenance-decision">
              <Group gap="xs" wrap="nowrap" mb={4}>
                <Badge
                  size="sm"
                  variant="light"
                  color={DECISION_COLORS[decision.action]}
                  className="maintenance-decision-action"
                >
                  {t(DECISION_LABELS[decision.action])}
                </Badge>
                <Text size="xs" c="dimmed" className="maintenance-decision-id">
                  {decision.extraction_id}
                </Text>
              </Group>
              <Text size="sm">{decision.reason}</Text>
              {decision.topics.length > 0 && (
                <Group gap={4} mt={6}>
                  {decision.topics.map((topic) => (
                    <Code key={topic}>{topic}</Code>
                  ))}
                </Group>
              )}
            </li>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
