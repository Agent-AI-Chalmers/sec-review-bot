import type { IncomingMessage, ServerResponse } from 'node:http'

import memoryTrajectory from '../data/memory-trajectory.json' with { type: 'json' }
import { BASE_TIME } from '../runs/generate.js'
import type {
  CatalogOverviewWorkflow,
  ExtractionRecord,
  ObservationRecord
} from '../../../browser/features/memory/api-types.generated.js'

const LOAD_ERROR_REVISION = 404
type SourceRunIds = Record<
  'repository-review' | 'pull-request-review' | 'issue-review',
  string
>

const trajectoryReference = {
  uri: 's3://sec-review/memory/trajectories/fixture/trajectory.v1.jsonl.zst',
  digest: `sha256:${'1'.repeat(64)}`,
  media_type: 'application/x-ndjson+zstd',
  size_bytes: 4096
}

export function createMemoryHandler(
  sourceRunIds: SourceRunIds
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let memoryControl = {
    state: 'enabled' as 'enabled' | 'paused',
    generation: 1,
    changed_by: { kind: 'service', id: 'memory-catalog' },
    changed_at: new Date(BASE_TIME).toISOString()
  }
  let activeMemoryRevision = 2
  const memoryFilesByRevision = new Map<number, Record<string, string>>([
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
          '# Security Review Experience Memory\n\nUse this short index to select relevant experience. Memory is guidance only; verify every claim against the current review target.\n\n- [Triage and reachability](topics/triage.md) - Scope the reachable attack path and affected boundary.\n- [Evidence quality](topics/evidence.md) - Ground findings and validation claims in current evidence.\n- [Authentication comparisons](topics/authentication.md) - Review secret comparison and failure behavior.\n',
        'topics/authentication.md':
          '# Authentication comparisons\n\n## Constant-time comparison\n\nBefore calling a constant-time comparison primitive, validate that both byte sequences have equal length. Some runtimes throw on unequal lengths, turning malformed credentials into a distinct failure path.\n\nReturn the same authentication failure response for length mismatch and value mismatch.\n',
        'topics/evidence.md':
          '# Evidence quality\n\n## Keep evidence layers separate\n\nDistinguish input claims, prior-stage summaries, repository facts, and runtime observations. Do not let a confident summary substitute for evidence from the prepared workspace.\n\n## Focused validation\n\nPrefer a small probe with a stable oracle. Report environmental failures as validation limits unless repository evidence connects them to the reviewed behavior.\n',
        'topics/triage.md':
          '# Triage and reachability\n\n## Confirm the path\n\nFollow attacker-controlled data through parsing, normalization, authorization, and the final sink. Name the first boundary that fails to enforce the required invariant.\n\n## Bound the claim\n\nDo not expand one repository-local defect into a broader vulnerability class without evidence that the adjacent surfaces share the same reachable behavior.\n'
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
  const memoryRevisions: Array<Record<string, unknown>> = [
    {
      revision: 3,
      predecessor_revision: 1,
      created_at: new Date(BASE_TIME + 120_000).toISOString(),
      source: {
        kind: 'operator',
        operation_id: 'fixture-operator-branch',
        actor: { kind: 'user', id: 'fixture-operator' }
      }
    },
    {
      revision: 2,
      predecessor_revision: 1,
      created_at: new Date(BASE_TIME + 60_000).toISOString(),
      source: {
        kind: 'maintenance',
        maintenance_id: 'fixture-maintenance-2',
        extraction_ids: ['fixture-extraction-2'],
        trajectory_reference: trajectoryReference
      }
    },
    {
      revision: 1,
      predecessor_revision: null,
      created_at: new Date(BASE_TIME).toISOString(),
      source: {
        kind: 'operator',
        operation_id: 'fixture-bootstrap-memory',
        actor: { kind: 'service', id: 'fixture-bootstrap' }
      }
    }
  ]
  const extractionRecords: ExtractionRecord[] = [
    {
      extraction_id: 'fixture-extraction-1',
      source_workflow: 'repository-review',
      source_run_id: sourceRunIds['repository-review'],
      source_unit_id: 'case-reachability',
      diagnostic_bundle_digest: `sha256:${'2'.repeat(64)}`,
      trajectory_reference: trajectoryReference,
      observation: null,
      created_at: new Date(BASE_TIME - 300_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-2',
      source_workflow: 'repository-review',
      source_run_id: sourceRunIds['repository-review'],
      source_unit_id: 'case-authentication',
      diagnostic_bundle_digest: `sha256:${'3'.repeat(64)}`,
      trajectory_reference: trajectoryReference,
      observation: {
        body_markdown:
          '**Reject unequal input lengths before calling `timingSafeEqual`.** Comparing buffers of different lengths throws instead of returning false, so validate the length first and fail authentication without exposing a distinct error path.'
      },
      created_at: new Date(BASE_TIME).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-3',
      source_workflow: 'repository-review',
      source_run_id: sourceRunIds['repository-review'],
      source_unit_id: 'case-proxy-boundary',
      diagnostic_bundle_digest: `sha256:${'4'.repeat(64)}`,
      trajectory_reference: trajectoryReference,
      observation: {
        body_markdown:
          '**Strip internal debugging headers when proxying upstream responses.** Forward only an explicit response-header allowlist so private identifiers and credentials cannot cross the service boundary.'
      },
      created_at: new Date(BASE_TIME + 120_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-4',
      source_workflow: 'pull-request-review',
      source_run_id: sourceRunIds['pull-request-review'],
      source_unit_id: 'pull-request',
      diagnostic_bundle_digest: `sha256:${'5'.repeat(64)}`,
      trajectory_reference: trajectoryReference,
      observation: {
        body_markdown:
          '**Perform tenant authorization before any lookup whose result reveals resource existence.** A post-lookup guard still permits status, timing, or error differences to disclose whether another tenant owns the requested object.'
      },
      created_at: new Date(BASE_TIME + 180_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-5',
      source_workflow: 'issue-review',
      source_run_id: sourceRunIds['issue-review'],
      source_unit_id: 'issue',
      diagnostic_bundle_digest: `sha256:${'6'.repeat(64)}`,
      trajectory_reference: trajectoryReference,
      observation: null,
      created_at: new Date(BASE_TIME + 240_000).toISOString()
    },
    {
      extraction_id: 'fixture-extraction-6',
      source_workflow: 'repository-review',
      source_run_id: sourceRunIds['repository-review'],
      source_unit_id: 'case-reachability',
      diagnostic_bundle_digest: `sha256:${'7'.repeat(64)}`,
      trajectory_reference: trajectoryReference,
      observation: null,
      created_at: new Date(BASE_TIME + 300_000).toISOString()
    }
  ]
  const consumedRevisionByExtraction = new Map([['fixture-extraction-2', 2]])
  const observations: ObservationRecord[] = extractionRecords.flatMap(
    (record) =>
      record.observation === null
        ? []
        : [
            {
              extraction_id: record.extraction_id,
              source_run_id: record.source_run_id,
              source_unit_id: record.source_unit_id,
              body_markdown: record.observation.body_markdown,
              consumed_revision:
                consumedRevisionByExtraction.get(record.extraction_id) ?? null,
              created_at: record.created_at
            }
          ]
  )
  const unitOutcomes = new Map<
    string,
    { source_workflow: string; hasObservation: boolean }
  >()
  for (const record of extractionRecords) {
    const key = `${record.source_run_id}\u0000${record.source_unit_id}`
    const current = unitOutcomes.get(key)
    unitOutcomes.set(key, {
      source_workflow: record.source_workflow,
      hasObservation:
        (current?.hasObservation ?? false) || record.observation !== null
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
    if (outcome.hasObservation) current.units_with_observation_count += 1
    else current.units_without_observation_count += 1
    workflowOutcomes.set(outcome.source_workflow, current)
  }
  return async (request, response): Promise<void> => {
    const requestUrl = request.url
    if (requestUrl === undefined) return
    if (
      requestUrl === '/api/memory/maintenance-control' &&
      request.method === 'GET'
    ) {
      response.end(JSON.stringify(memoryControl))
      return
    }
    if (requestUrl === '/api/memory/tree' && request.method === 'GET') {
      response.end(JSON.stringify({ revision: activeMemoryRevision }))
      return
    }
    if (
      requestUrl.startsWith('/api/memory/overview') &&
      request.method === 'GET'
    ) {
      const range = new URL(
        requestUrl,
        'http://control-plane-ui.local'
      ).searchParams.get('range')
      const pointCount = range === '90d' ? 90 : range === 'all' ? 12 : 30
      const activePoints = new Map([
        [pointCount - 7, [1, 1]],
        [pointCount - 4, [2, 1]],
        [pointCount - 1, [2, 1]]
      ])
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
              (observation) => observation.consumed_revision === null
            ).length,
            consumed_observation_count: observations.filter(
              (observation) => observation.consumed_revision !== null
            ).length
          },
          trend_granularity: range === 'all' ? 'month' : 'day',
          trend_points: Array.from({ length: pointCount }, (_, index) => {
            const outcome = activePoints.get(index) ?? [0, 0]
            const date = new Date(BASE_TIME)
            if (range === 'all') {
              date.setUTCDate(1)
              date.setUTCMonth(date.getUTCMonth() - (pointCount - 1 - index))
            } else {
              date.setUTCDate(date.getUTCDate() - (pointCount - 1 - index))
            }
            return {
              period_start: date.toISOString().slice(0, 10),
              extracted_unit_count: outcome[0],
              units_with_observation_count: outcome[1]
            }
          }),
          workflows: [...workflowOutcomes.values()]
        })
      )
      return
    }
    if (
      requestUrl.startsWith('/api/memory/revisions?') &&
      request.method === 'GET'
    ) {
      response.end(
        JSON.stringify({
          revisions: memoryRevisions,
          next_before_revision: null
        })
      )
      return
    }
    if (
      requestUrl.startsWith('/api/memory/observations?') &&
      request.method === 'GET'
    ) {
      response.end(
        JSON.stringify({
          observations: [...observations].reverse(),
          next_cursor: null
        })
      )
      return
    }
    if (
      requestUrl.startsWith('/api/memory/extractions?') &&
      request.method === 'GET'
    ) {
      response.end(
        JSON.stringify({
          extractions: [...extractionRecords].reverse(),
          next_cursor: null
        })
      )
      return
    }
    const memoryRevisionMatch =
      /^\/api\/memory\/revisions\/([1-9][0-9]*)$/.exec(requestUrl)
    if (request.method === 'GET' && memoryRevisionMatch !== null) {
      const revision = Number(memoryRevisionMatch[1])
      const record = memoryRevisions.find(
        (item) => Number(item.revision) === revision
      )
      if (record === undefined) response.statusCode = 404
      response.end(JSON.stringify(record ?? { error: 'revision_not_found' }))
      return
    }
    const memoryTrajectoryContentMatch =
      /^\/api\/memory\/(revisions|extractions)\/([^/?]+)\/trajectory\/content$/.exec(
        requestUrl
      )
    if (request.method === 'GET' && memoryTrajectoryContentMatch !== null) {
      if (
        memoryTrajectoryContentMatch[1] === 'revisions' &&
        Number(memoryTrajectoryContentMatch[2]) === LOAD_ERROR_REVISION
      ) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'memory_catalog_unavailable' }))
        return
      }
      response.end(JSON.stringify(memoryTrajectory))
      return
    }
    const memoryDownloadMatch =
      /^\/api\/memory\/(revisions|extractions)\/([^/?]+)\/(artifact|trajectory)$/.exec(
        requestUrl
      )
    if (request.method === 'GET' && memoryDownloadMatch !== null) {
      const collection = memoryDownloadMatch[1]
      const identity = memoryDownloadMatch[2] ?? ''
      const kind = memoryDownloadMatch[3]
      const revision = Number(identity)
      const available =
        collection === 'revisions'
          ? memoryFilesByRevision.has(revision) ||
            revision === LOAD_ERROR_REVISION
          : extractionRecords.some(
              (record) => record.extraction_id === identity
            )
      if (
        !available ||
        (collection === 'extractions' && kind !== 'trajectory')
      ) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'memory_artifact_not_found' }))
        return
      }
      const filename =
        kind === 'artifact'
          ? 'memory-tree.v1.tar.zst'
          : 'memory-trajectory.v1.jsonl.zst'
      const content = Buffer.from(`fixture ${collection} ${identity} ${kind}\n`)
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader(
        'content-disposition',
        `attachment; filename="${filename}"`
      )
      response.setHeader('content-length', String(content.length))
      response.end(content)
      return
    }
    const memoryContentMatch =
      /^\/api\/memory\/revisions\/([1-9][0-9]*)\/content$/.exec(requestUrl)
    if (request.method === 'GET' && memoryContentMatch !== null) {
      const revision = Number(memoryContentMatch[1])
      if (revision === LOAD_ERROR_REVISION) {
        response.statusCode = 422
        response.end(JSON.stringify({ error: 'invalid_memory_tree_artifact' }))
        return
      }
      const files = memoryFilesByRevision.get(revision)
      if (files === undefined) response.statusCode = 404
      response.end(
        JSON.stringify(files === undefined ? { error: 'not_found' } : { files })
      )
      return
    }
    const memoryWriteMatch =
      /^\/api\/memory\/(pause|resume|edit|restore)$/.exec(requestUrl)
    if (request.method === 'POST' && memoryWriteMatch !== null) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
      const action = memoryWriteMatch[1]
      if (action === 'pause' || action === 'resume') {
        if (body.expected_generation !== memoryControl.generation) {
          response.statusCode = 409
          response.end(JSON.stringify({ error: 'generation_conflict' }))
          return
        }
        memoryControl = {
          state: action === 'pause' ? 'paused' : 'enabled',
          generation: memoryControl.generation + 1,
          changed_by: { kind: 'service', id: 'control-plane-ui' },
          changed_at: new Date().toISOString()
        }
        response.end(JSON.stringify(memoryControl))
        return
      }
      if (body.expected_active_revision !== activeMemoryRevision) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: 'revision_conflict' }))
        return
      }
      if (action === 'restore') {
        const restoredRevision = Number(body.restored_revision)
        if (!memoryFilesByRevision.has(restoredRevision)) {
          response.statusCode = 404
          response.end(JSON.stringify({ error: 'restore_target_unavailable' }))
          return
        }
        activeMemoryRevision = restoredRevision
        response.statusCode = 201
        response.end(
          JSON.stringify({
            created: true,
            active_revision: restoredRevision,
            operation_id: body.operation_id
          })
        )
        return
      }
      const nextRevision =
        Math.max(...memoryRevisions.map((item) => Number(item.revision))) + 1
      const files = body.files as Record<string, string>
      memoryFilesByRevision.set(nextRevision, { ...files })
      memoryRevisions.unshift({
        revision: nextRevision,
        predecessor_revision: activeMemoryRevision,
        created_at: new Date().toISOString(),
        source: {
          kind: 'operator',
          operation_id: body.operation_id,
          actor: { kind: 'service', id: 'control-plane-ui' }
        }
      })
      activeMemoryRevision = nextRevision
      response.statusCode = 201
      response.end(JSON.stringify(memoryRevisions[0]))
      return
    }
  }
}
