import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  MemoryTreeContentResponse,
  TrajectoryContentResponse
} from '../../shared/artifact-content.js'
import historySamples from '../data/memory-history-samples.json' with { type: 'json' }
import memoryTrajectory from '../data/memory-trajectory.json' with { type: 'json' }
import { validateTrajectoryEvent } from '../../shared/trajectory-events.js'
import type {
  CatalogOverviewWorkflow,
  ExtractionRecord,
  ObservationRecord,
  MemoryTreeAutomation,
  MemoryTreeAutomationOperationResult
} from '../../browser/features/memory/api-types.generated.js'

const trajectoryContent: TrajectoryContentResponse = {
  events: memoryTrajectory.events.map(validateTrajectoryEvent)
}

const LOAD_ERROR_VERSION = 404

export type MemorySourceRuns = Record<
  'repository-review' | 'pull-request-review' | 'issue-review',
  { runId: string; archiveDigest: string }
>

const trajectoryReference = {
  uri: 's3://sec-review/memory/trajectories/fixture/trajectory.v1.jsonl.zst',
  digest: `sha256:${'1'.repeat(64)}`,
  media_type: 'application/x-ndjson+zstd',
  size_bytes: 4096
}

export function createMemoryHandler(
  sourceRuns: MemorySourceRuns,
  BASE_TIME: number,
  now: () => number
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let memoryAutomation: MemoryTreeAutomation = {
    state: 'enabled',
    version: 1,
    changed_by: { kind: 'service', id: 'memory-catalog' },
    changed_at: new Date(BASE_TIME).toISOString()
  }
  let activeMemoryVersion = 2
  const memoryFilesByVersion = new Map<number, Record<string, string>>([
    [
      1,
      {
        'MEMORY.md':
          '# Security Review Experience Memory\n\nUse this index to load only the topic relevant to the current review. Memory is guidance, not evidence for the current repository.\n\n- [Triage and reachability](topics/triage.md) - Establish attacker reachability before assigning severity.\n- [Evidence quality](topics/evidence.md) - Separate repository evidence from inherited claims.\n',
        'topics/evidence.md':
          '# Evidence quality\n\n## Repository grounding\n\nTreat issue text and prior summaries as leads. Confirm material claims against the current code, configuration, or focused runtime evidence.\n\n## Validation labels\n\nUse the strongest validation level actually reached and record concrete proof gaps instead of upgrading partial evidence.\n',
        'topics/triage.md':
          '# Triage and reachability\n\n## Reachability first\n\nTrace untrusted input to the claimed boundary before assigning severity. A dangerous helper is not exploitable when every reachable caller enforces the missing invariant.\n\n## Scope control\n\nKeep adjacent independent weaknesses separate from the reviewed claim.\n'
      }
    ],
    [
      2,
      {
        'MEMORY.md':
          '# Security Review Experience Memory\n\nUse this short index to select relevant experience. Memory is guidance only; verify every claim against the current review target.\n\n- [Triage and reachability](topics/triage.md) - Scope the reachable attack path and affected boundary.\n- [Evidence quality](topics/evidence.md) - Ground findings and validation claims in current evidence.\n- [Authentication comparisons](topics/authentication.md) - Review secret comparison and failure behavior.\n- [Service boundaries](topics/boundaries.md) - Limit what proxied responses carry across a trust boundary.\n',
        'topics/boundaries.md':
          '# Service boundaries\n\n## Proxied response headers\n\nForward only an explicit allowlist of upstream response headers. Internal debugging headers can carry private identifiers or credentials across the service boundary.\n',
        'topics/authentication.md':
          '# Authentication comparisons\n\n## Constant-time comparison\n\nBefore calling a constant-time comparison primitive, validate that both byte sequences have equal length. Some runtimes throw on unequal lengths, turning malformed credentials into a distinct failure path.\n\nReturn the same authentication failure response for length mismatch and value mismatch.\n',
        'topics/evidence.md':
          '# Evidence quality\n\n## Keep evidence layers separate\n\nDistinguish input claims, prior-stage summaries, repository facts, and runtime observations. Do not let a confident summary substitute for evidence from the prepared workspace.\n\n## Focused validation\n\nPrefer a small probe with a stable oracle. Report environmental failures as validation limits unless repository evidence connects them to the reviewed behavior.\n',
        'topics/triage.md':
          '# Triage and reachability\n\n## Confirm the path\n\nFollow attacker-controlled data through parsing, normalization, authorization, and the final sink. Name the first boundary that fails to enforce the required invariant.\n\n## Authorize before lookup\n\nCheck tenant authorization before any lookup whose result reveals resource existence. A guard after the lookup can still leak existence through status, timing, or error differences.\n\n## Bound the claim\n\nDo not expand one repository-local defect into a broader vulnerability class without evidence that the adjacent surfaces share the same reachable behavior.\n'
      }
    ],
    [
      3,
      {
        'MEMORY.md':
          '# Security Review Experience Memory\n\nThis operator branch keeps the index intentionally narrow.\n\n- [Triage and reachability](topics/triage.md) - Confirm the reachable path before expanding scope.\n- [Evidence quality](topics/evidence.md) - Keep inherited claims separate from current evidence.\n',
        'topics/evidence.md':
          '# Evidence quality\n\n## Operator branch\n\nRecord the exact evidence that supports each conclusion and preserve explicit validation limits.\n',
        'topics/triage.md':
          '# Triage and reachability\n\n## Operator branch\n\nPrefer a bounded claim tied to a demonstrated path over a broader speculative class.\n'
      }
    ]
  ])
  const memoryVersions: Array<Record<string, unknown>> = [
    {
      version: 3,
      predecessor_version: 1,
      created_at: new Date(BASE_TIME + 120_000).toISOString(),
      source: {
        kind: 'manual',
        operation_id: 'fixture-operator-branch',
        actor: { kind: 'user', id: 'fixture-operator' }
      }
    },
    {
      version: 2,
      predecessor_version: 1,
      created_at: new Date(BASE_TIME + 60_000).toISOString(),
      source: {
        kind: 'learning',
        operation_id: 'fixture-maintenance-2',
        observation_ids: [
          'observation-fixture-extraction-2-1',
          'observation-fixture-extraction-3-1',
          'observation-fixture-extraction-4-1'
        ],
        trajectory_reference: trajectoryReference,
        maintenance_report: {
          summary:
            'Added authentication and service-boundary guidance from two observations and folded tenant authorization ordering into the existing triage topic.',
          observation_decisions: [
            {
              observation_id: 'observation-fixture-extraction-2-1',
              action: 'added',
              topics: ['/memory/topics/authentication.md'],
              reason:
                'Length validation before constant-time comparison is a reusable authentication check that memory did not cover.'
            },
            {
              observation_id: 'observation-fixture-extraction-3-1',
              action: 'added',
              topics: ['/memory/topics/boundaries.md', '/memory/MEMORY.md'],
              reason:
                'Header allowlisting at proxy boundaries is a distinct, reusable pattern, so it gets its own topic and index entry.'
            },
            {
              observation_id: 'observation-fixture-extraction-4-1',
              action: 'merged',
              topics: ['/memory/topics/triage.md'],
              reason:
                'Authorization ordering refines the existing reachability guidance rather than forming a separate topic.'
            }
          ]
        }
      }
    },
    {
      version: 1,
      predecessor_version: null,
      created_at: new Date(BASE_TIME).toISOString(),
      source: {
        kind: 'manual',
        operation_id: 'fixture-bootstrap-memory',
        actor: { kind: 'service', id: 'fixture-bootstrap' }
      }
    }
  ]
  const extractionRecords: ExtractionRecord[] = [
    {
      extraction_id: 'fixture-extraction-1',
      source_workflow: 'repository-review',
      source_run_id: sourceRuns['repository-review'].runId,
      source_unit_id: 'case-reachability',
      execution_archive_digest: sourceRuns['repository-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [],
      created_at: new Date(BASE_TIME - 300_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-2',
      source_workflow: 'repository-review',
      source_run_id: sourceRuns['repository-review'].runId,
      source_unit_id: 'case-authentication',
      execution_archive_digest: sourceRuns['repository-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [
        {
          observation_id: 'extraction-1',
          body_markdown:
            '**Reject unequal input lengths before calling `timingSafeEqual`.** Comparing buffers of different lengths throws instead of returning false, so validate the length first and fail authentication without exposing a distinct error path.'
        }
      ],
      created_at: new Date(BASE_TIME).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-3',
      source_workflow: 'repository-review',
      source_run_id: sourceRuns['repository-review'].runId,
      source_unit_id: 'case-proxy-boundary',
      execution_archive_digest: sourceRuns['repository-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [
        {
          observation_id: 'extraction-1',
          body_markdown:
            '**Strip internal debugging headers when proxying upstream responses.** Forward only an explicit response-header allowlist so private identifiers and credentials cannot cross the service boundary.'
        }
      ],
      created_at: new Date(BASE_TIME + 120_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-4',
      source_workflow: 'pull-request-review',
      source_run_id: sourceRuns['pull-request-review'].runId,
      source_unit_id: 'pull-request',
      execution_archive_digest: sourceRuns['pull-request-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [
        {
          observation_id: 'extraction-1',
          body_markdown:
            '**Perform tenant authorization before any lookup whose result reveals resource existence.** A post-lookup guard still permits status, timing, or error differences to disclose whether another tenant owns the requested object.'
        }
      ],
      created_at: new Date(BASE_TIME + 180_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-5',
      source_workflow: 'issue-review',
      source_run_id: sourceRuns['issue-review'].runId,
      source_unit_id: 'issue',
      execution_archive_digest: sourceRuns['issue-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [],
      created_at: new Date(BASE_TIME + 240_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-6',
      source_workflow: 'repository-review',
      source_run_id: sourceRuns['repository-review'].runId,
      source_unit_id: 'case-reachability',
      execution_archive_digest: sourceRuns['repository-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [],
      created_at: new Date(BASE_TIME + 300_000).toISOString()
    }
  ]
  const consumedVersionByObservation = new Map([
    ['observation-fixture-extraction-2-1', 2],
    ['observation-fixture-extraction-3-1', 2],
    ['observation-fixture-extraction-4-1', 2]
  ])
  // Sanitized observation samples exercise learning, operator edits, and
  // reorganization across an illustrative history. Each observation is registered
  // once, including pending work.
  for (const record of [...memoryVersions, ...extractionRecords]) {
    record.created_at = new Date(
      Date.parse(String(record.created_at)) - 64 * 3_600_000
    ).toISOString()
  }
  let sampleIndex = 0
  for (let version = 4; version <= 60; version += 1) {
    const predecessor = version === 4 ? 2 : version === 56 ? 53 : version - 1
    const files = { ...memoryFilesByVersion.get(predecessor)! }
    const createdAt = new Date(BASE_TIME - (61 - version) * 3_600_000).toISOString()
    let source: Record<string, unknown>
    if (version % 7 === 0) {
      files['MEMORY.md'] += '\nReview only guidance relevant to the current trust boundary.\n'
      source = {
        kind: 'manual',
        operation_id: `fixture-edit-${version}`,
        actor: { kind: 'user', id: 'review-operator' }
      }
    } else if (version % 5 === 0) {
      files['MEMORY.md'] =
        '# Security Review Experience Memory\n\nSelect a topic, then verify its applicability against current repository evidence.\n\n' +
        Object.keys(files)
          .filter((path) => path.startsWith('topics/'))
          .sort()
          .map((path) => `- [${path}](${path})`)
          .join('\n') +
        '\n'
      source = {
        kind: 'reorganization',
        operation_id: `fixture-reorganize-${version}`,
        trajectory_reference: trajectoryReference,
        maintenance_report: {
          summary:
            'Consolidated the topic index and preserved the evidence and applicability limits of existing guidance.',
          observation_decisions: []
        }
      }
    } else {
      const sample = historySamples[sampleIndex++]
      const extractionId = `fixture-history-${sampleIndex}`
      consumedVersionByObservation.set(`observation-${extractionId}-1`, version)
      extractionRecords.push({
        extraction_id: extractionId,
        source_workflow: 'repository-review',
        source_run_id: sourceRuns['repository-review'].runId,
        source_unit_id: `case-${sampleIndex}`,
        execution_archive_digest: sourceRuns['repository-review'].archiveDigest,
        trajectory_reference: trajectoryReference,
        observations: [{ observation_id: 'extraction-1', body_markdown: sample.body }],
        created_at: new Date(Date.parse(createdAt) - 900_000).toISOString()
      })
      if (sample.action !== 'skipped') {
        for (const topic of sample.topics) {
          const path = topic.replace('/memory/', '')
          files[path] =
            `${files[path] ?? '# Review guidance\n'}\n${sample.action === 'conflict' ? '## Unresolved conflict\n\n' : ''}${sample.body}\n`
        }
      }
      source = {
        kind: 'learning',
        operation_id: `fixture-learning-${version}`,
        observation_ids: [`observation-${extractionId}-1`],
        trajectory_reference: trajectoryReference,
        maintenance_report: {
          summary: sample.reason,
          observation_decisions: [
            {
              observation_id: `observation-${extractionId}-1`,
              action: sample.action,
              topics: sample.topics,
              reason: sample.reason
            }
          ]
        }
      }
    }
    memoryFilesByVersion.set(version, files)
    memoryVersions.unshift({
      version,
      predecessor_version: predecessor,
      created_at: createdAt,
      source
    })
  }
  for (; sampleIndex < historySamples.length; sampleIndex += 1) {
    const sample = historySamples[sampleIndex]
    extractionRecords.push({
      extraction_id: `fixture-history-${sampleIndex + 1}`,
      source_workflow: 'repository-review',
      source_run_id: sourceRuns['repository-review'].runId,
      source_unit_id: `case-${sampleIndex + 1}`,
      execution_archive_digest: sourceRuns['repository-review'].archiveDigest,
      trajectory_reference: trajectoryReference,
      observations: [{ observation_id: 'extraction-1', body_markdown: sample.body }],
      created_at: new Date(BASE_TIME - (historySamples.length - sampleIndex) * 60_000).toISOString()
    })
  }
  // The operator restored the predecessor after inspecting the latest reorganization.
  activeMemoryVersion = 59
  extractionRecords.sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const record of extractionRecords) {
    for (const [index, observation] of record.observations.entries()) {
      observation.observation_id = `observation-${record.extraction_id}-${index + 1}`
    }
  }
  const authenticationExtraction = extractionRecords.find(
    (record) => record.extraction_id === 'fixture-extraction-2'
  )!
  authenticationExtraction.observations.push({
    observation_id: 'observation-fixture-extraction-2-2',
    body_markdown:
      '**Validate credential shape before comparison.** Reject malformed credential values before invoking the authentication comparator.'
  })
  const observations: ObservationRecord[] = extractionRecords.flatMap((record) =>
    record.observations.map((observation) => ({
      observation_id: observation.observation_id,
      extraction_id: record.extraction_id,
      source_run_id: record.source_run_id,
      source_unit_id: record.source_unit_id,
      body_markdown: observation.body_markdown,
      consumed_version: consumedVersionByObservation.get(observation.observation_id) ?? null,
      created_at: record.created_at
    }))
  )
  const unitOutcomes = new Map<string, { source_workflow: string; hasObservation: boolean }>()
  for (const record of extractionRecords) {
    const key = `${record.source_run_id}\u0000${record.source_unit_id}`
    const current = unitOutcomes.get(key)
    unitOutcomes.set(key, {
      source_workflow: record.source_workflow,
      hasObservation: (current?.hasObservation ?? false) || record.observations.length > 0
    })
  }
  const workflowOutcomes = new Map<string, CatalogOverviewWorkflow>()
  for (const outcome of unitOutcomes.values()) {
    const current = workflowOutcomes.get(outcome.source_workflow) ?? {
      source_workflow: outcome.source_workflow,
      extracted_unit_count: 0,
      units_with_observation_count: 0,
      units_without_observation_count: 0
    }
    current.extracted_unit_count += 1
    if (outcome.hasObservation) {
      current.units_with_observation_count += 1
    } else {
      current.units_without_observation_count += 1
    }
    workflowOutcomes.set(outcome.source_workflow, current)
  }
  return async (request, response): Promise<void> => {
    const requestUrl = request.url
    if (requestUrl === undefined) {
      return
    }
    if (requestUrl === '/api/memory/tree/automation' && request.method === 'GET') {
      response.end(JSON.stringify(memoryAutomation))
      return
    }
    if (requestUrl === '/api/memory/tree' && request.method === 'GET') {
      response.end(JSON.stringify({ version: activeMemoryVersion }))
      return
    }
    if (requestUrl.startsWith('/api/memory/overview') && request.method === 'GET') {
      const range = new URL(requestUrl, 'http://control-plane-ui.local').searchParams.get('range')
      const pointCount = range === '90d' ? 90 : range === 'all' ? 12 : 30
      response.end(
        JSON.stringify({
          totals: {
            completed_extraction_count: extractionRecords.length,
            extracted_unit_count: unitOutcomes.size,
            units_with_observation_count: [...unitOutcomes.values()].filter(
              (outcome) => outcome.hasObservation
            ).length,
            units_without_observation_count: [...unitOutcomes.values()].filter(
              (outcome) => !outcome.hasObservation
            ).length,
            observation_count: observations.length,
            pending_observation_count: observations.filter(
              (observation) => observation.consumed_version === null
            ).length,
            consumed_observation_count: observations.filter(
              (observation) => observation.consumed_version !== null
            ).length
          },
          trend_granularity: range === 'all' ? 'month' : 'day',
          trend_points: Array.from({ length: pointCount }, (_, index) => {
            const date = new Date(BASE_TIME)
            if (range === 'all') {
              date.setUTCDate(1)
              date.setUTCMonth(date.getUTCMonth() - (pointCount - 1 - index))
            } else {
              date.setUTCDate(date.getUTCDate() - (pointCount - 1 - index))
            }
            const period = date.toISOString().slice(0, range === 'all' ? 7 : 10)
            const units = new Map<string, boolean>()
            for (const record of extractionRecords) {
              if (!record.created_at.startsWith(period)) {
                continue
              }
              const key = `${record.source_run_id}:${record.source_unit_id}`
              units.set(key, (units.get(key) ?? false) || record.observations.length > 0)
            }
            return {
              period_start: date.toISOString().slice(0, 10),
              extracted_unit_count: units.size,
              units_with_observation_count: [...units.values()].filter(Boolean).length
            }
          }),
          workflows: [...workflowOutcomes.values()]
        })
      )
      return
    }
    if (requestUrl.startsWith('/api/memory/versions?') && request.method === 'GET') {
      // Honor before_version paging like the catalog: newest first, exclusive.
      const query = new URL(requestUrl, 'http://fixture').searchParams
      const limit = Number(query.get('limit') ?? '50')
      const before = query.get('before_version')
      const matching = memoryVersions.filter(
        (version) => before === null || Number(version.version) < Number(before)
      )
      const page = matching.slice(0, limit)
      response.end(
        JSON.stringify({
          versions: page,
          next_before_version: matching.length > limit ? Number(page.at(-1)?.version) : null
        })
      )
      return
    }
    if (requestUrl.startsWith('/api/memory/observations?') && request.method === 'GET') {
      // Honor the catalog's version filter and cursor so the UI's paging and
      // report-to-observation jump behave as they do against the real catalog.
      const query = new URL(requestUrl, 'http://fixture').searchParams
      const consumedVersion = query.get('consumed_version')
      const limit = Number(query.get('limit') ?? '50')
      const offset = Number(query.get('cursor') ?? '0')
      const matching = [...observations]
        .reverse()
        .filter(
          (observation) =>
            consumedVersion === null || observation.consumed_version === Number(consumedVersion)
        )
      const page = matching.slice(offset, offset + limit)
      response.end(
        JSON.stringify({
          observations: page,
          next_cursor: offset + limit < matching.length ? String(offset + limit) : null
        })
      )
      return
    }
    if (requestUrl.startsWith('/api/memory/extractions?') && request.method === 'GET') {
      response.end(
        JSON.stringify({
          extractions: extractionRecords.toReversed(),
          next_cursor: null
        })
      )
      return
    }
    const memoryVersionMatch = /^\/api\/memory\/versions\/([1-9][0-9]*)$/.exec(requestUrl)
    if (request.method === 'GET' && memoryVersionMatch !== null) {
      const version = Number(memoryVersionMatch[1])
      const record = memoryVersions.find((item) => Number(item.version) === version)
      if (record === undefined) {
        response.statusCode = 404
      }
      response.end(JSON.stringify(record ?? { error: 'version_not_found' }))
      return
    }
    const memoryTrajectoryContentMatch =
      /^\/api\/memory\/(versions|extractions)\/([^/?]+)\/trajectory\/content$/.exec(requestUrl)
    if (request.method === 'GET' && memoryTrajectoryContentMatch !== null) {
      if (
        memoryTrajectoryContentMatch[1] === 'versions' &&
        Number(memoryTrajectoryContentMatch[2]) === LOAD_ERROR_VERSION
      ) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'memory_catalog_unavailable' }))
        return
      }
      response.end(JSON.stringify(trajectoryContent))
      return
    }
    const memoryDownloadMatch =
      /^\/api\/memory\/(versions|extractions)\/([^/?]+)\/(artifact|trajectory)$/.exec(requestUrl)
    if (request.method === 'GET' && memoryDownloadMatch !== null) {
      const collection = memoryDownloadMatch[1]
      const identity = memoryDownloadMatch[2] ?? ''
      const kind = memoryDownloadMatch[3]
      const version = Number(identity)
      const available =
        collection === 'versions'
          ? memoryFilesByVersion.has(version) || version === LOAD_ERROR_VERSION
          : extractionRecords.some((record) => record.extraction_id === identity)
      if (!available || (collection === 'extractions' && kind !== 'trajectory')) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'memory_artifact_not_found' }))
        return
      }
      const filename =
        kind === 'artifact' ? 'memory-tree.v1.tar.zst' : 'memory-trajectory.v1.jsonl.zst'
      const content = Buffer.from(`fixture ${collection} ${identity} ${kind}\n`)
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('content-disposition', `attachment; filename="${filename}"`)
      response.setHeader('content-length', String(content.length))
      response.end(content)
      return
    }
    const memoryContentMatch = /^\/api\/memory\/versions\/([1-9][0-9]*)\/content$/.exec(requestUrl)
    if (request.method === 'GET' && memoryContentMatch !== null) {
      const version = Number(memoryContentMatch[1])
      if (version === LOAD_ERROR_VERSION) {
        response.statusCode = 422
        response.end(JSON.stringify({ error: 'invalid_memory_tree_artifact' }))
        return
      }
      const files = memoryFilesByVersion.get(version)
      if (files === undefined) {
        response.statusCode = 404
      }
      response.end(
        JSON.stringify(
          files === undefined
            ? { error: 'not_found' }
            : ({ files } satisfies MemoryTreeContentResponse)
        )
      )
      return
    }
    const memoryWriteMatch =
      /^\/api\/memory\/(?:tree\/automation\/(pause|resume)|(edit|restore))$/.exec(requestUrl)
    if (request.method === 'POST' && memoryWriteMatch !== null) {
      const chunks: Buffer[] = []
      for await (const chunk of request as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const action = memoryWriteMatch[1] ?? memoryWriteMatch[2]
      if (action === 'pause' || action === 'resume') {
        if (body.expected_version !== memoryAutomation.version) {
          response.statusCode = 409
          response.end(JSON.stringify({ error: 'version_conflict' }))
          return
        }
        memoryAutomation = {
          state: action === 'pause' ? 'paused' : 'enabled',
          version: memoryAutomation.version + 1,
          changed_by: { kind: 'service', id: 'control-plane-ui' },
          changed_at: new Date(now()).toISOString()
        }
        response.statusCode = 201
        response.end(
          JSON.stringify({
            created: true,
            automation: memoryAutomation
          } satisfies MemoryTreeAutomationOperationResult)
        )
        return
      }
      if (body.expected_active_version !== activeMemoryVersion) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: 'version_conflict' }))
        return
      }
      if (action === 'restore') {
        const restoredVersion = Number(body.restored_version)
        if (!memoryFilesByVersion.has(restoredVersion)) {
          response.statusCode = 404
          response.end(JSON.stringify({ error: 'restore_target_unavailable' }))
          return
        }
        activeMemoryVersion = restoredVersion
        response.statusCode = 201
        response.end(
          JSON.stringify({
            created: true,
            active_version: restoredVersion,
            operation_id: body.operation_id
          })
        )
        return
      }
      const nextVersion = Math.max(...memoryVersions.map((item) => Number(item.version))) + 1
      const files = body.files as Record<string, string>
      memoryFilesByVersion.set(nextVersion, { ...files })
      memoryVersions.unshift({
        version: nextVersion,
        predecessor_version: activeMemoryVersion,
        created_at: new Date(now()).toISOString(),
        source: {
          kind: 'manual',
          operation_id: body.operation_id,
          actor: { kind: 'service', id: 'control-plane-ui' }
        }
      })
      activeMemoryVersion = nextVersion
      response.statusCode = 201
      response.end(JSON.stringify(memoryVersions[0]))
      return
    }
  }
}
