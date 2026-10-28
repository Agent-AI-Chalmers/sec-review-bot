import React from 'react'
import { Badge, Button, Drawer, Group, Table, Text } from '@mantine/core'

import type { Run } from './api.js'
import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'

type Statistics = NonNullable<Run['execution_statistics']>
type StatisticsGroup = Statistics['groups'][number]
type Usage = Statistics['token_usage']
type Workflow = Run['workflow']

interface UsageSection {
  key: string
  label: string
  groups: StatisticsGroup[]
}

interface AgentSummary {
  groups: StatisticsGroup[]
  breakdowns: Map<string, UsageSection[]>
}

function formatCount(value: number | null, language: 'en' | 'zh'): string {
  return value === null
    ? '—'
    : value.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
}

function statusPresentation(statistics: Statistics): {
  color: string
  label: 'statisticsPending' | 'statisticsReconciling' | 'statisticsUnavailable'
} | null {
  if (statistics.reconciliation_status === 'pending')
    return { color: 'gray', label: 'statisticsPending' }
  if (statistics.reconciliation_status === 'reconciling')
    return { color: 'blue', label: 'statisticsReconciling' }
  if (statistics.reconciliation_status === 'unavailable')
    return { color: 'red', label: 'statisticsUnavailable' }
  return null
}

function UsageDetails({ usage }: { usage: Usage }): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const details = [
    [t('statisticsInputTokens'), usage.input_tokens],
    [t('statisticsOutputTokens'), usage.output_tokens],
    [t('statisticsCacheReadTokens'), usage.cache_read_input_tokens]
  ] as const
  return (
    <Group gap="xs" wrap="wrap" className="statistics-usage-details">
      {details.map(([label, value]) => (
        <Text key={label} size="xs" c="dimmed">
          {label} {formatCount(value, language)}
        </Text>
      ))}
    </Group>
  )
}

function passLabel(
  group: StatisticsGroup,
  t: ReturnType<typeof useMessages>
): string {
  if (group.pass_kind === 'feedback')
    return `${t('statisticsFeedbackPass')} ${group.pass_index ?? 1}`
  if (group.pass_kind === 'initial') return t('statisticsInitialPass')
  if (group.pass_kind === 'draft')
    return group.batch_index === null
      ? t('statisticsDraftPass')
      : `${t('statisticsDraftBatch')} ${group.batch_index}`
  if (group.pass_kind === 'refinement') return t('statisticsRefinementPass')
  return t('statisticsUnclassifiedPass')
}

function passSections(
  groups: StatisticsGroup[],
  t: ReturnType<typeof useMessages>
): UsageSection[] {
  const sections = new Map<string, UsageSection>()
  const add = (key: string, label: string, group: StatisticsGroup): void => {
    const existing = sections.get(key)
    if (existing === undefined)
      sections.set(key, { key, label, groups: [group] })
    else existing.groups.push(group)
  }

  for (const group of groups) {
    const passKey = `${group.pass_kind ?? 'unknown'}:${group.pass_index ?? -1}:${group.batch_index ?? -1}`
    add(passKey, passLabel(group, t), group)
  }
  return [...sections.values()]
}

function groupCallCount(groups: StatisticsGroup[]): number {
  return groups.reduce((sum, group) => sum + group.model_call_count, 0)
}

function groupTokenCount(groups: StatisticsGroup[]): number | null {
  let total = 0
  for (const group of groups) {
    if (group.token_usage.total_tokens === null) return null
    total += group.token_usage.total_tokens
  }
  return total
}

function agentGroupKey(group: StatisticsGroup): string {
  return [group.agent_name, group.provider, group.model ?? ''].join(':')
}

function summedUsage(groups: StatisticsGroup[]): Usage {
  const sum = (read: (usage: Usage) => number | null): number | null => {
    let total = 0
    for (const group of groups) {
      const value = read(group.token_usage)
      if (value === null) return null
      total += value
    }
    return total
  }
  return {
    input_tokens: sum((usage) => usage.input_tokens),
    output_tokens: sum((usage) => usage.output_tokens),
    total_tokens: sum((usage) => usage.total_tokens),
    cache_read_input_tokens: sum((usage) => usage.cache_read_input_tokens),
    cache_creation_input_tokens: sum(
      (usage) => usage.cache_creation_input_tokens
    ),
    reasoning_tokens: sum((usage) => usage.reasoning_tokens)
  }
}

function summarizeAgents(
  groups: StatisticsGroup[],
  breakdownLabelFor: (group: StatisticsGroup) => string | null
): AgentSummary {
  const grouped = new Map<string, StatisticsGroup[]>()
  const breakdownGroups = new Map<string, Map<string, StatisticsGroup[]>>()
  for (const group of groups) {
    const key = agentGroupKey(group)
    grouped.set(key, [...(grouped.get(key) ?? []), group])
    const label = breakdownLabelFor(group)
    if (label !== null) {
      const agentBreakdowns = breakdownGroups.get(key) ?? new Map()
      agentBreakdowns.set(label, [...(agentBreakdowns.get(label) ?? []), group])
      breakdownGroups.set(key, agentBreakdowns)
    }
  }
  return {
    groups: [...grouped.values()].map((agentGroups) => {
      const first = agentGroups[0]!
      return {
        ...first,
        case_id: null,
        delivery_id: null,
        pass_kind: null,
        pass_index: null,
        batch_index: null,
        chunk_id: null,
        model_call_count: groupCallCount(agentGroups),
        usage_reported_call_count: agentGroups.reduce(
          (sum, group) => sum + group.usage_reported_call_count,
          0
        ),
        token_usage: summedUsage(agentGroups),
        agent_name: first.agent_name,
        provider: first.provider,
        model: first.model
      }
    }),
    breakdowns: new Map(
      [...breakdownGroups].map(([key, breakdown]) => [
        key,
        [...breakdown].map(([label, breakdownItems]) => ({
          key: label,
          label,
          groups: breakdownItems
        }))
      ])
    )
  }
}

function isOnlyInitialPass(sections: UsageSection[]): boolean {
  return (
    sections.length === 1 &&
    sections[0]?.groups.every(
      (group) =>
        group.pass_kind === 'initial' &&
        group.pass_index === 0 &&
        group.batch_index === null
    ) === true
  )
}

function SummaryMetrics({
  groups,
  prefix
}: {
  groups: StatisticsGroup[]
  prefix?: string
}): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  return (
    <Text size="xs" c="dimmed" className="statistics-unit-metrics">
      {prefix !== undefined && <>{prefix} · </>}
      {formatCount(groupCallCount(groups), language)} {t('statisticsCalls')} ·{' '}
      {formatCount(groupTokenCount(groups), language)}{' '}
      {t('statisticsTokenUnit')}
    </Text>
  )
}

function AgentBreakdown({
  sections
}: {
  sections: UsageSection[]
}): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const totalUsage = summedUsage(sections.flatMap((section) => section.groups))
  const usageCells = (usage: Usage): React.JSX.Element[] =>
    [
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens
    ].map((value, index) => (
      <Table.Td key={index} ta="right">
        {formatCount(value, language)}
      </Table.Td>
    ))
  return (
    <Table.ScrollContainer minWidth={420}>
      <Table className="statistics-agent-breakdown">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('statisticsCallBreakdown')}</Table.Th>
            <Table.Th ta="right">{t('statisticsInputTokens')}</Table.Th>
            <Table.Th ta="right">{t('statisticsOutputTokens')}</Table.Th>
            <Table.Th ta="right">{t('statisticsCacheReadTokens')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sections.map((section) => (
            <Table.Tr key={section.key}>
              <Table.Td>{section.label}</Table.Td>
              {usageCells(summedUsage(section.groups))}
            </Table.Tr>
          ))}
          <Table.Tr className="statistics-agent-breakdown-total">
            <Table.Td>{t('statisticsTotal')}</Table.Td>
            {usageCells(totalUsage)}
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

function StatisticsTable({
  section,
  breakdowns,
  expandedGroups,
  toggleGroup
}: {
  section: UsageSection
  breakdowns?: Map<string, UsageSection[]>
  expandedGroups: Set<string>
  toggleGroup: (key: string) => void
}): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  return (
    <section className="statistics-section">
      {section.label !== '' && (
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text size="sm" fw={600}>
            {section.label}
          </Text>
          <Text size="xs" c="dimmed">
            {formatCount(groupCallCount(section.groups), language)}{' '}
            {t('statisticsCalls')}
          </Text>
        </Group>
      )}
      <Table.ScrollContainer minWidth={240}>
        <Table className="statistics-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('statisticsAgent')}</Table.Th>
              <Table.Th className="statistics-model-column">
                {t('statisticsModel')}
              </Table.Th>
              <Table.Th className="statistics-numeric-column" ta="center">
                {t('statisticsCalls')}
              </Table.Th>
              <Table.Th className="statistics-numeric-column" ta="right">
                {t('statisticsTokens')}
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {section.groups.map((group) => {
              const key = [
                section.key,
                group.agent_name,
                group.batch_index ?? '',
                group.chunk_id ?? '',
                group.provider,
                group.model ?? ''
              ].join(':')
              const expanded = expandedGroups.has(key)
              const groupBreakdown = breakdowns?.get(agentGroupKey(group)) ?? []
              return (
                <React.Fragment key={key}>
                  <Table.Tr
                    className="statistics-group-row"
                    data-group-key={key}
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(key)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      toggleGroup(key)
                    }}
                  >
                    <Table.Td>
                      <code>{group.agent_name}</code>
                      <div className="statistics-mobile-model">
                        <Text size="xs" className="statistics-model-identity">
                          <Text component="span" c="dimmed">
                            {group.provider}/
                          </Text>
                          <Text component="span" fw={600} ff="monospace">
                            {group.model ?? t('statisticsUnknownModel')}
                          </Text>
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatCount(group.model_call_count, language)}{' '}
                          {t('statisticsCalls')} ·{' '}
                          {formatCount(
                            group.token_usage.total_tokens,
                            language
                          )}{' '}
                          {t('statisticsTokenUnit')}
                        </Text>
                      </div>
                    </Table.Td>
                    <Table.Td className="statistics-model-column">
                      <Text size="sm" className="statistics-model-identity">
                        <Text component="span" c="dimmed">
                          {group.provider}/
                        </Text>
                        <Text component="span" fw={600} ff="monospace">
                          {group.model ?? t('statisticsUnknownModel')}
                        </Text>
                      </Text>
                    </Table.Td>
                    <Table.Td className="statistics-numeric-column" ta="center">
                      {formatCount(group.model_call_count, language)}
                    </Table.Td>
                    <Table.Td className="statistics-numeric-column" ta="right">
                      {formatCount(group.token_usage.total_tokens, language)}
                    </Table.Td>
                  </Table.Tr>
                  {expanded && (
                    <Table.Tr className="statistics-group-detail">
                      <Table.Td colSpan={4}>
                        {groupBreakdown.length > 0 && (
                          <AgentBreakdown sections={groupBreakdown} />
                        )}
                        {groupBreakdown.length === 0 && (
                          <UsageDetails usage={group.token_usage} />
                        )}
                      </Table.Td>
                    </Table.Tr>
                  )}
                </React.Fragment>
              )
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </section>
  )
}

function RepositoryBreakdown({
  groups,
  expandedGroups,
  toggleGroup
}: {
  groups: StatisticsGroup[]
  expandedGroups: Set<string>
  toggleGroup: (key: string) => void
}): React.JSX.Element {
  const t = useMessages()
  const scanGroups = groups.filter(
    (group) =>
      group.case_id === null &&
      group.delivery_id === null &&
      group.agent_name !== 'repository-delivery-planner' &&
      group.agent_name !== 'patch-synthesizer'
  )
  const caseGroups = new Map<string, StatisticsGroup[]>()
  const deliveryStageGroups: StatisticsGroup[] = []

  for (const group of groups) {
    if (group.case_id !== null) {
      const existing = caseGroups.get(group.case_id) ?? []
      existing.push(group)
      caseGroups.set(group.case_id, existing)
    } else if (group.agent_name === 'repository-delivery-planner') {
      deliveryStageGroups.push(group)
    } else if (
      group.delivery_id !== null ||
      group.agent_name === 'patch-synthesizer'
    ) {
      deliveryStageGroups.push(group)
    }
  }
  const scanSummary = summarizeAgents(scanGroups, (group) =>
    group.agent_name === 'repository-triager'
      ? passLabel(group, t)
      : group.chunk_id
  )
  const deliverySummary = summarizeAgents(deliveryStageGroups, (group) => {
    if (group.agent_name === 'repository-delivery-planner')
      return passLabel(group, t)
    return group.delivery_id
  })

  return (
    <div className="statistics-workflow-stages">
      <details className="statistics-workflow-stage">
        <summary>
          <span>{t('statisticsScanStage')}</span>
          <SummaryMetrics groups={scanGroups} />
        </summary>
        <div className="statistics-stage-body">
          <StatisticsTable
            section={{ key: 'scan', label: '', groups: scanSummary.groups }}
            breakdowns={scanSummary.breakdowns}
            expandedGroups={expandedGroups}
            toggleGroup={toggleGroup}
          />
        </div>
      </details>

      <details className="statistics-workflow-stage">
        <summary>
          <span>{t('statisticsReviewStage')}</span>
          <SummaryMetrics
            groups={[...caseGroups.values()].flat()}
            prefix={`${caseGroups.size} ${t('statisticsCases')}`}
          />
        </summary>
        <div className="statistics-stage-body statistics-units">
          {[...caseGroups].map(([caseId, caseUsageGroups]) => {
            const sections = passSections(caseUsageGroups, t)
            const onlyInitialPass = isOnlyInitialPass(sections)
            return (
              <details key={caseId} className="statistics-unit">
                <summary>
                  <span>
                    {t('statisticsCase')} {caseId}
                  </span>
                  <SummaryMetrics groups={caseUsageGroups} />
                </summary>
                <div className="statistics-unit-body">
                  {onlyInitialPass ? (
                    <StatisticsTable
                      section={{
                        ...sections[0],
                        key: `case:${caseId}:initial:0`,
                        label: ''
                      }}
                      expandedGroups={expandedGroups}
                      toggleGroup={toggleGroup}
                    />
                  ) : (
                    sections.map((section) => (
                      <StatisticsTable
                        key={`${caseId}:${section.key}`}
                        section={{
                          ...section,
                          key: `case:${caseId}:${section.key}`
                        }}
                        expandedGroups={expandedGroups}
                        toggleGroup={toggleGroup}
                      />
                    ))
                  )}
                </div>
              </details>
            )
          })}
        </div>
      </details>

      <details className="statistics-workflow-stage">
        <summary>
          <span>{t('statisticsDeliveryStage')}</span>
          <SummaryMetrics groups={deliveryStageGroups} />
        </summary>
        <div className="statistics-stage-body">
          <StatisticsTable
            section={{
              key: 'delivery',
              label: '',
              groups: deliverySummary.groups
            }}
            breakdowns={deliverySummary.breakdowns}
            expandedGroups={expandedGroups}
            toggleGroup={toggleGroup}
          />
        </div>
      </details>
    </div>
  )
}

function PassBreakdown({
  sections,
  expandedGroups,
  toggleGroup
}: {
  sections: UsageSection[]
  expandedGroups: Set<string>
  toggleGroup: (key: string) => void
}): React.JSX.Element {
  if (isOnlyInitialPass(sections)) {
    const section = sections[0]
    return (
      <StatisticsTable
        section={{ ...section, label: '' }}
        expandedGroups={expandedGroups}
        toggleGroup={toggleGroup}
      />
    )
  }
  return (
    <div className="statistics-workflow-stages">
      {sections.map((section) => (
        <details key={section.key} className="statistics-workflow-stage">
          <summary>
            <span>{section.label}</span>
            <SummaryMetrics groups={section.groups} />
          </summary>
          <div className="statistics-stage-body">
            <StatisticsTable
              section={{ ...section, label: '' }}
              expandedGroups={expandedGroups}
              toggleGroup={toggleGroup}
            />
          </div>
        </details>
      ))}
    </div>
  )
}

export function ExecutionStatistics({
  statistics,
  workflow
}: {
  statistics: Run['execution_statistics']
  workflow: Workflow
}): React.JSX.Element | null {
  const { language } = useLanguage()
  const t = useMessages()
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(
    () => new Set()
  )
  const [detailsOpened, setDetailsOpened] = React.useState(false)
  const detailsRef = React.useRef<HTMLDivElement>(null)
  if (statistics === null) return null
  const status = statusPresentation(statistics)
  const noObservations = statistics.ingestion_status === 'no_observations'
  const partial =
    statistics.ingestion_status === 'partial_window' ||
    statistics.usage_coverage === 'partial'
  // A successful empty read is meaningful: show "0 calls" instead of making it look like no
  // statistics exist. A never-read pending row and an unavailable dependency still stay empty.
  const hasObservedUsage =
    statistics.usage_coverage === 'complete_for_observed_calls' ||
    statistics.usage_coverage === 'partial' ||
    statistics.observed_call_count > 0 ||
    statistics.token_usage.total_tokens !== null
  const hasDetails = hasObservedUsage || statistics.groups.length > 0
  const sections = passSections(statistics.groups, t)
  const toggleGroup = (key: string): void => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const expandAll = (): void => {
    const root = detailsRef.current
    if (root === null) return
    root.querySelectorAll('details').forEach((detail) => {
      detail.open = true
    })
    const keys = [
      ...root.querySelectorAll<HTMLElement>('.statistics-group-row')
    ]
      .map((row) => row.dataset.groupKey)
      .filter((key): key is string => key !== undefined)
    setExpandedGroups(new Set(keys))
  }
  const collapseAll = (): void => {
    const root = detailsRef.current
    if (root === null) return
    root.querySelectorAll('details').forEach((detail) => {
      detail.open = false
    })
    setExpandedGroups(new Set())
  }

  return (
    <div className="execution-statistics" data-testid="execution-statistics">
      <Group gap="xs" align="center" wrap="wrap">
        <Text size="sm" fw={600}>
          {t('statisticsTitle')}
        </Text>
        {status !== null && (
          <Badge size="sm" color={status.color}>
            {t(status.label)}
          </Badge>
        )}
        {hasObservedUsage && (
          <Text size="sm" c="dimmed">
            {formatCount(statistics.observed_call_count, language)}{' '}
            {t('statisticsCalls')} ·{' '}
            {formatCount(statistics.token_usage.total_tokens, language)}{' '}
            {t('statisticsTokenUnit')}
          </Text>
        )}
        {hasDetails && (
          <Button
            variant="subtle"
            size="compact-xs"
            className="statistics-details-button"
            onClick={() => setDetailsOpened(true)}
          >
            {t('statisticsViewDetails')}
          </Button>
        )}
      </Group>
      {partial && (
        <Text size="xs" c="yellow" mt={4} data-testid="statistics-warning">
          {t('statisticsPartialWarning')}
        </Text>
      )}
      {noObservations && (
        <Text
          size="xs"
          c="dimmed"
          mt={4}
          data-testid="statistics-no-observations"
        >
          {t('statisticsNoObservations')}
        </Text>
      )}
      {hasDetails && (
        <Drawer
          opened={detailsOpened}
          onClose={() => setDetailsOpened(false)}
          position="right"
          size="xl"
          title={t('statisticsDetailsTitle')}
        >
          <div
            className="execution-statistics-details"
            data-testid="execution-statistics-details"
            ref={detailsRef}
          >
            <Group justify="flex-end" gap="xs" mb="xs">
              <Button variant="subtle" size="compact-xs" onClick={expandAll}>
                {t('statisticsExpandAll')}
              </Button>
              <Button variant="subtle" size="compact-xs" onClick={collapseAll}>
                {t('statisticsCollapseAll')}
              </Button>
            </Group>
            {hasObservedUsage && (
              <UsageDetails usage={statistics.token_usage} />
            )}
            <Text size="xs" c="dimmed" mt="sm">
              {t('statisticsUpdated')}{' '}
              {formatDate(statistics.updated_at, language)}
            </Text>
            <div className="statistics-groups">
              {workflow === 'repository-review' ? (
                <RepositoryBreakdown
                  groups={statistics.groups}
                  expandedGroups={expandedGroups}
                  toggleGroup={toggleGroup}
                />
              ) : (
                <PassBreakdown
                  sections={sections}
                  expandedGroups={expandedGroups}
                  toggleGroup={toggleGroup}
                />
              )}
            </div>
          </div>
        </Drawer>
      )}
    </div>
  )
}
