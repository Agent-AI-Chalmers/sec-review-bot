import { expect, test } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

import { devFixtures } from '../scripts/dev-fixtures/index.js'
import type {
  Run,
  ListRunsResponseBodyByStatus,
  RunEvent
} from '../browser/features/runs/api-types.generated.js'
import type {
  ExtractionList,
  ObservationList,
  CatalogOverview,
  MemoryTreeVersionList
} from '../browser/features/memory/api-types.generated.js'

/**
 * The fixture plugin registers one connect-style middleware. Capturing it lets a real
 * http server drive it, so the test exercises the same request/response objects the
 * plugin sees in `vite` instead of hand-rolled fakes.
 */
function captureMiddleware(): (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => void {
  const plugin: Plugin = devFixtures()
  const configureServer = plugin.configureServer
  expect.assert(typeof configureServer === 'function')
  let middleware:
    | ((request: IncomingMessage, response: ServerResponse, next: () => void) => void)
    | undefined
  const fakeServer = {
    middlewares: {
      use(
        handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void
      ): void {
        middleware = handler
      }
    }
  }
  // `devFixtures` never reads `this`, so invoking the hook with the fake server alone is
  // faithful; the cast only satisfies Vite's `this: MinimalPluginContext` signature.
  const runConfigureServer = configureServer as (server: typeof fakeServer) => void
  runConfigureServer(fakeServer)
  expect.assert(middleware !== undefined)
  return middleware
}

/** Starts the fixture middleware behind a real server and returns a close helper. */
async function startFixtureServer(): Promise<{
  base: string
  close: () => Promise<void>
}> {
  const middleware = captureMiddleware()
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  expect.assert(address && typeof address === 'object')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('dev fixtures only describe reachable run states', async () => {
  // runs/generate.ts validates every generated run at import time and throws on a
  // combination Review Runs cannot produce (for example a failed execution
  // whose publication is still `pending`). Importing it is therefore the assertion:
  // this test exists so an unreachable fixture fails CI instead of silently
  // showing operators a state that cannot happen.
  await import('../scripts/dev-fixtures/runs/generate.js')
})

test('dev fixtures distinguish a statistics snapshot from no snapshot', async () => {
  const { runs, stepsByRun } = await import('../scripts/dev-fixtures/runs/generate.js')
  const completed = runs.filter((run) => run.execution.status === 'succeeded')
  const active = runs.find((run) => run.execution.status === 'running')
  const agentsFor = (workflow: (typeof completed)[number]['workflow']): string[] => {
    const run = completed.find((candidate) => candidate.workflow === workflow)
    expect.assert(run !== undefined)
    const statistics = run.execution_statistics
    expect.assert(statistics !== null)
    return [...new Set(statistics.groups.map((group) => group.agent_name))]
  }
  expect(agentsFor('issue-review')).toStrictEqual([
    'issue-analyzer',
    'issue-mitigator',
    'issue-verifier'
  ])
  expect(agentsFor('pull-request-review')).toStrictEqual([
    'pull-request-analyzer',
    'pull-request-mitigator',
    'pull-request-verifier'
  ])
  expect(agentsFor('repository-review')).toStrictEqual([
    'repository-discovery',
    'repository-triager',
    'repository-analyzer',
    'repository-cvss-v4-scorer',
    'repository-mitigator',
    'repository-verifier',
    'repository-delivery-planner',
    'patch-synthesizer'
  ])
  const repositoryRun = completed.find((run) => run.workflow === 'repository-review')
  expect.assert(repositoryRun !== undefined)
  const patchDeliveryIds = repositoryRun.execution_statistics?.groups
    .filter((group) => group.agent_name === 'patch-synthesizer')
    .map((group) => group.delivery_id)
  expect.assert(patchDeliveryIds !== undefined)
  expect.assert(patchDeliveryIds.length >= 2)
  const publicationDeliveryIds = (stepsByRun.get(repositoryRun.run_id) ?? [])
    .map((step) => step.step_key.match(/^repository:delivery:(.+)$/)?.[1])
    .filter((deliveryId): deliveryId is string => deliveryId !== undefined)
  expect(patchDeliveryIds).toStrictEqual(publicationDeliveryIds)
  for (const run of completed) {
    const statistics = run.execution_statistics
    expect.assert(statistics !== null)
    const usages = [statistics.token_usage, ...statistics.groups.map((group) => group.token_usage)]
    for (const usage of usages) {
      if (
        usage.input_tokens !== null &&
        usage.output_tokens !== null &&
        usage.total_tokens !== null
      ) {
        expect(
          usage.total_tokens,
          'fixture total_tokens must equal inclusive input_tokens + output_tokens'
        ).toBe(usage.input_tokens + usage.output_tokens)
      }
      if (usage.input_tokens !== null && usage.cache_read_input_tokens !== null) {
        expect.assert(
          usage.cache_read_input_tokens <= usage.input_tokens,
          'fixture cache_read_input_tokens must be a subset of input_tokens'
        )
      }
      if (usage.input_tokens !== null && usage.cache_creation_input_tokens !== null) {
        expect.assert(
          usage.cache_creation_input_tokens <= usage.input_tokens,
          'fixture cache_creation_input_tokens must be a subset of input_tokens'
        )
      }
      if (usage.output_tokens !== null && usage.reasoning_tokens !== null) {
        expect.assert(
          usage.reasoning_tokens <= usage.output_tokens,
          'fixture reasoning_tokens must be a subset of output_tokens'
        )
      }
    }
  }
  for (const workflow of ['issue-review', 'pull-request-review'] as const) {
    const workflowRuns = completed.filter((run) => run.workflow === workflow)
    expect.assert(
      workflowRuns.some((run) =>
        run.execution_statistics?.groups.some((group) => group.agent_phase === 'feedback')
      ),
      `${workflow} fixtures must include a feedback loop`
    )
    expect.assert(
      workflowRuns.some(
        (run) => !run.execution_statistics?.groups.some((group) => group.agent_phase === 'feedback')
      ),
      `${workflow} fixtures must include a run without feedback`
    )
  }
  expect(active?.execution_statistics).toBe(null)
})

test('dev fixtures track sign-out so the console reaches the sign-in form', async () => {
  // The fixtures exist to show the console's real screens with no access token, so
  // they start signed in — a run list must be reachable before any session call.
  const fixture = await startFixtureServer()
  try {
    const signedIn = await fetch(`${fixture.base}/api/runs?limit=1`)
    expect(signedIn.status).toBe(200)

    // Signing out mirrors the BFF: 204, and every later API call is unauthorized so
    // the console switches to its sign-in form rather than reloading the run list.
    const signOut = await fetch(`${fixture.base}/api/session`, {
      method: 'DELETE'
    })
    expect(signOut.status).toBe(204)

    const afterSignOut = await fetch(`${fixture.base}/api/runs?limit=1`)
    expect(afterSignOut.status).toBe(401)
    expect(await afterSignOut.json()).toStrictEqual({ error: 'unauthorized' })

    // Signing back in restores the run list: POST is the only way to become signed in.
    const signIn = await fetch(`${fixture.base}/api/session`, {
      method: 'POST'
    })
    expect(signIn.status).toBe(204)

    const afterSignIn = await fetch(`${fixture.base}/api/runs?limit=1`)
    expect(afterSignIn.status).toBe(200)
  } finally {
    await fixture.close()
  }
})

/**
 * The queue offers three decisions, and a dev server that answers two of them teaches the
 * operator a button that visibly fails. The decision itself must be the one Review Runs
 * records: the disconnected axis ends as a failure whose code names the operator, so the
 * detail page after the decision is a state the store can actually produce.
 */
test('dev fixtures answer the give-up decision the queue offers', async () => {
  const fixture = await startFixtureServer()
  try {
    const parked = (await (await fetch(`${fixture.base}/api/runs/parked`)).json()) as {
      blocks: { run_id: string }[]
    }
    const runId = parked.blocks[0]?.run_id
    expect.assert(runId !== undefined)
    const endpoint = `${fixture.base}/api/admin/runs/${encodeURIComponent(runId)}/give-up`
    const headers = {
      'content-type': 'application/json',
      'x-review-runs-admin-token': 'fixture-admin-token'
    }

    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'not waiting' })
        })
      ).status
    ).toBe(401)
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({})
        })
      ).status
    ).toBe(400)

    const givenUp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'the outcome cannot be established' })
    })
    expect(givenUp.status).toBe(200)
    const record = (await givenUp.json()) as {
      run: { notices: { kind: string; reason_code: string | null }[] }
    }
    expect(record.run.notices[0]?.kind).toBe('failure')
    expect(record.run.notices[0]?.reason_code ?? '').toMatch(/BY_OPERATOR$/)

    const after = (await (await fetch(`${fixture.base}/api/runs/parked`)).json()) as {
      blocks: { run_id: string }[]
    }
    expect(after.blocks.some((block) => block.run_id === runId)).toBe(false)
  } finally {
    await fixture.close()
  }
})

test('mutating one fixture server does not change another server’s run state', async () => {
  await using resources = new AsyncDisposableStack()
  const first = await startFixtureServer()
  resources.defer(first.close)
  const second = await startFixtureServer()
  resources.defer(second.close)
  const parked = (await (await fetch(`${first.base}/api/runs/parked`)).json()) as {
    blocks: { run_id: string; axis: string }[]
  }
  const runId = parked.blocks.find((block) => block.axis === 'preparation')?.run_id
  expect.assert(runId)
  const response = await fetch(`${first.base}/api/admin/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'x-review-runs-admin-token': 'fixture-admin-token' }
  })
  expect(response.status).toBe(200)
  const remaining = (await (await fetch(`${second.base}/api/runs/parked`)).json()) as {
    blocks: { run_id: string; axis: string }[]
  }
  expect(remaining.blocks).toContainEqual(
    expect.objectContaining({ run_id: runId, axis: 'preparation' })
  )
})

test('dev fixtures leave non-API requests to the next middleware', async () => {
  // The middleware must not claim routes outside `/api/`; the fixture server's `next`
  // handler answers 404, which stands in for Vite's own asset middleware.
  const fixture = await startFixtureServer()
  try {
    const asset = await fetch(`${fixture.base}/index.html`)
    expect(asset.status).toBe(404)
  } finally {
    await fixture.close()
  }
})

test('dev fixtures serve memory actions as downloads', async () => {
  const fixture = await startFixtureServer()
  try {
    for (const [path, filename] of [
      ['/api/memory/versions/2/artifact', 'attachment; filename="memory-tree.v1.tar.zst"'],
      [
        '/api/memory/versions/2/trajectory',
        'attachment; filename="memory-trajectory.v1.jsonl.zst"'
      ],
      [
        '/api/memory/extractions/fixture-extraction-2/trajectory',
        'attachment; filename="memory-trajectory.v1.jsonl.zst"'
      ]
    ] as const) {
      const response = await fetch(`${fixture.base}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('content-disposition')).toBe(filename)
      expect.assert((await response.arrayBuffer()).byteLength > 0)
    }
  } finally {
    await fixture.close()
  }
})

test('dev fixtures expose stable full-page load-error scenarios', async () => {
  const fixture = await startFixtureServer()
  try {
    for (const [path, status, error] of [
      ['/api/memory/versions/404/content', 422, 'invalid_memory_tree_artifact'],
      ['/api/memory/versions/404/trajectory/content', 503, 'memory_catalog_unavailable'],
      ['/api/runs/fixture-artifact-load-error/artifact/content', 503, 'review_runs_unavailable']
    ] as const) {
      const response = await fetch(`${fixture.base}${path}`)
      expect(response.status).toBe(status)
      expect(await response.json()).toStrictEqual({ error })
    }

    const download = await fetch(`${fixture.base}/api/memory/versions/404/artifact`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="memory-tree.v1.tar.zst"'
    )
  } finally {
    await fixture.close()
  }
})

test('dev fixtures page the run list in the order their cursor describes', async () => {
  // The run list is built in scenario order, and an active run's timestamp is anchored near
  // now rather than at its newest historical slot, so array order is not creation order. The
  // fixture has to sort by the same `(created_at, run_id)` key its cursor compares against,
  // or `created_at < cursor.createdAt` matches every row and page two repeats page one - the
  // paging affordance then silently disappears wherever the fixture is the only server.
  const fixture = await startFixtureServer()
  try {
    const first = await ((await fetch(`${fixture.base}/api/runs?limit=50`)).json() as Promise<
      ListRunsResponseBodyByStatus['200']
    >)
    const stamps = first.runs.map((run: { created_at: string }) => run.created_at)
    expect(stamps, 'the list is newest-first, which is what the cursor walks').toStrictEqual(
      [...stamps].sort().reverse()
    )
    expect.assert(first.next_cursor, 'sixty-two fixtures must not fit one page of fifty')

    const second = await ((
      await fetch(`${fixture.base}/api/runs?limit=50&cursor=${first.next_cursor}`)
    ).json() as Promise<ListRunsResponseBodyByStatus['200']>)
    const firstIds = new Set(first.runs.map((run: { run_id: string }) => run.run_id))
    expect.assert(second.runs.length > 0, 'the cursor must return a second page')
    for (const run of second.runs as { run_id: string }[]) {
      expect.assert(!firstIds.has(run.run_id), `${run.run_id} appears on both pages`)
    }
  } finally {
    await fixture.close()
  }
})

test('the unfiltered list does not lead with a row that satisfies a filter lookup', async () => {
  // The browser flow opens "the first row" after selecting a filter, and waits for that
  // row to look filtered. When the newest run already looks like the filter's result before
  // the filtered response arrives, the wait passes against the stale list and the test opens
  // a run the filter excluded - which is how a run with no publication start reached an
  // assertion about a published phase.
  //
  // The browser flow now checks two columns instead of one, but the fixtures must not depend on
  // that: the newest run stays outside the (workflow, publication) combination the flow
  // filters for, so a one-column wait cannot pass early again.
  const fixture = await startFixtureServer()
  try {
    const unfiltered = await ((await fetch(`${fixture.base}/api/runs?limit=1`)).json() as Promise<
      ListRunsResponseBodyByStatus['200']
    >)
    const newest = unfiltered.runs[0]
    expect.assert(newest, 'the fixtures must serve at least one run')
    expect.assert(
      !(newest.workflow === 'repository-review' && newest.publication.status === 'published'),
      'the newest run must not already look like the published repository filter'
    )
  } finally {
    await fixture.close()
  }
})

test('run fixtures filter by source platform', async () => {
  const fixture = await startFixtureServer()
  try {
    const github = await ((
      await fetch(`${fixture.base}/api/runs?source_platform=github&limit=1`)
    ).json() as Promise<ListRunsResponseBodyByStatus['200']>)
    expect(github.runs[0]?.source_platform).toBe('github')

    const gitlab = await ((
      await fetch(`${fixture.base}/api/runs?source_platform=gitlab&limit=1`)
    ).json() as Promise<ListRunsResponseBodyByStatus['200']>)
    expect(gitlab.runs[0]?.source_platform).toBe('gitlab')

    const unknown = await ((
      await fetch(`${fixture.base}/api/runs?source_platform=unknown&limit=1`)
    ).json() as Promise<ListRunsResponseBodyByStatus['200']>)
    expect(unknown.runs[0]?.source_platform).toBe('unknown')
  } finally {
    await fixture.close()
  }
})

test('memory fixtures form one coherent provenance graph', async () => {
  const fixture = await startFixtureServer()
  try {
    const [extractions, observations, overview, versions] = await Promise.all([
      fetch(`${fixture.base}/api/memory/extractions?limit=100`).then(
        (response) => response.json() as Promise<ExtractionList>
      ),
      fetch(`${fixture.base}/api/memory/observations?limit=100`).then(
        (response) => response.json() as Promise<ObservationList>
      ),
      fetch(`${fixture.base}/api/memory/overview?range=30d`).then(
        (response) => response.json() as Promise<CatalogOverview>
      ),
      fetch(`${fixture.base}/api/memory/versions?limit=100`).then(
        (response) => response.json() as Promise<MemoryTreeVersionList>
      )
    ])

    type FixtureExtraction = {
      extraction_id: string
      source_run_id: string
      source_unit_id: string
      observations: { observation_id: string; body_markdown: string }[]
    }

    const extractionById = new Map<string, FixtureExtraction>(
      extractions.extractions.map(
        (record: FixtureExtraction) => [record.extraction_id, record] as const
      )
    )

    expect(extractions.next_cursor).toBe(null)
    expect(extractions.extractions).toHaveLength(48)
    expect(observations.next_cursor).toBe(null)
    expect(observations.observations).toHaveLength(46)
    expect(overview.totals.completed_extraction_count).toBe(extractions.extractions.length)
    expect(overview.totals.observation_count).toBe(observations.observations.length)
    expect(
      overview.totals.pending_observation_count + overview.totals.consumed_observation_count
    ).toBe(observations.observations.length)
    expect(
      overview.totals.units_with_observation_count + overview.totals.units_without_observation_count
    ).toBe(overview.totals.extracted_unit_count)
    expect(
      overview.workflows.reduce(
        (total: number, workflow: { extracted_unit_count: number }) =>
          total + workflow.extracted_unit_count,
        0
      )
    ).toBe(overview.totals.extracted_unit_count)

    const siblings = observations.observations.filter(
      (item: { extraction_id: string }) => item.extraction_id === 'fixture-extraction-2'
    )
    expect(siblings).toHaveLength(2)
    expect(
      new Set(siblings.map((item: { observation_id: string }) => item.observation_id)).size
    ).toBe(2)
    expect.assert(
      siblings.some((item: { consumed_version: number | null }) => item.consumed_version === null)
    )
    expect.assert(
      siblings.some((item: { consumed_version: number | null }) => item.consumed_version === 2)
    )
    expect.assert(
      observations.observations.every(
        (item: { observation_id: string; extraction_id: string }) =>
          item.observation_id !== item.extraction_id
      )
    )

    for (const observation of observations.observations as Array<{
      observation_id: string
      extraction_id: string
      source_run_id: string
      source_unit_id: string
      body_markdown: string
      consumed_version: number | null
    }>) {
      const extraction = extractionById.get(observation.extraction_id)
      expect.assert(extraction, `${observation.extraction_id} must exist`)
      expect(extraction.source_run_id).toBe(observation.source_run_id)
      expect(extraction.source_unit_id).toBe(observation.source_unit_id)
      expect(
        extraction.observations.find((item) => item.observation_id === observation.observation_id)
          ?.body_markdown
      ).toBe(observation.body_markdown)

      const runResponse = await fetch(
        `${fixture.base}/api/runs/${encodeURIComponent(observation.source_run_id)}`
      )
      expect(runResponse.status).toBe(200)
      const { run } = await (runResponse.json() as Promise<{ run: Run }>)
      expect(run.source_platform).toBe('github')
      expect(run.execution.status).toBe('succeeded')
      expect(run.publication.status).toBe('published')
      expect(run.artifact_storage?.status).toBe('available')

      if (observation.consumed_version !== null) {
        const version = versions.versions.find(
          (candidate: { version: number }) => candidate.version === observation.consumed_version
        )
        expect.assert(version, 'a consumed observation must name an existing version')
        expect.assert(version.source.kind === 'learning')
        expect(version.source.observation_ids).toContain(observation.observation_id)
      }
    }

    for (const version of versions.versions as Array<{
      source:
        | {
            kind: 'learning'
            observation_ids: string[]
            maintenance_report: {
              observation_decisions: { observation_id: string }[]
            }
          }
        | { kind: 'manual'; operation_id: string; actor: unknown }
        | { kind: 'reorganization'; operation_id: string }
    }>) {
      if (version.source.kind === 'learning') {
        expect(
          version.source.maintenance_report.observation_decisions
            .map((decision) => decision.observation_id)
            .sort(),
          'maintenance decisions must identify every consumed observation'
        ).toStrictEqual(version.source.observation_ids.toSorted())
        for (const observationId of version.source.observation_ids) {
          const observation = observations.observations.find(
            (candidate: { observation_id: string }) => candidate.observation_id === observationId
          )
          expect.assert(
            observation,
            `${observationId} consumed by a version must have an observation`
          )
        }
      } else if (version.source.kind === 'manual') {
        expect.assert(version.source.operation_id)
        expect.assert(version.source.actor)
      }
    }
  } finally {
    await fixture.close()
  }
})

test('fixture event responses preserve the contract reason for a failed transition', async () => {
  const { runs } = await import('../scripts/dev-fixtures/runs/generate.js')
  const run = runs.find(
    (value) => value.preparation.status === 'failed' && value.preparation.failure_code !== null
  )!
  const fixture = await startFixtureServer()
  try {
    const response = await fetch(`${fixture.base}/api/runs/${run.run_id}/events`)
    expect(response.status).toBe(200)
    const body = await (response.json() as Promise<{ events: RunEvent[] }>)
    const transition = body.events.find(
      (event: { axis: string; to_status: string }) =>
        event.axis === 'preparation' && event.to_status === 'failed'
    )
    expect.assert(transition)
    expect(transition.reason_code).toBe(run.preparation.failure_code)
  } finally {
    await fixture.close()
  }
})

test('fixture events show a step that failed and was retried inside a publication that succeeded', async () => {
  // Step events are what tell a publication's own history apart from its steps': without one
  // run whose step failed and recovered, every step event in the fixtures would be a clean
  // success and the console would never show the difference locally.
  const { runs, stepsByRun } = await import('../scripts/dev-fixtures/runs/generate.js')
  const run = runs.find((value) =>
    (stepsByRun.get(value.run_id) ?? []).some(
      (step) => step.status === 'succeeded' && step.attempt_count > 1
    )
  )
  expect.assert(run, 'one fixture run retries a step')
  expect(run.publication.status).toBe('published')
  const fixture = await startFixtureServer()
  try {
    const response = await fetch(`${fixture.base}/api/runs/${run.run_id}/events`)
    const { events } = (await response.json()) as {
      events: Array<{
        axis: string
        step_key: string | null
        from_status: string | null
        to_status: string
        occurred_at: string
      }>
    }
    const publication = events.filter(
      (event) => event.axis === 'publication' && event.step_key === null
    )
    const steps = events.filter((event) => event.step_key !== null && event.from_status !== null)
    const retried = steps.filter((event) =>
      steps.some((other) => other.step_key === event.step_key && other.to_status === 'failed')
    )
    expect(retried.map((event) => `${event.from_status}->${event.to_status}`)).toStrictEqual([
      'pending->running',
      'running->failed',
      'failed->running',
      'running->succeeded'
    ])
    // The publication brackets its steps: it starts before the first and concludes after the last.
    const started = publication.find((event) => event.to_status === 'publishing')
    const concluded = publication.find((event) => event.to_status === 'published')
    expect.assert(started && concluded)
    for (const step of steps) {
      expect.assert(Date.parse(step.occurred_at) > Date.parse(started.occurred_at))
      expect.assert(Date.parse(step.occurred_at) < Date.parse(concluded.occurred_at))
    }
  } finally {
    await fixture.close()
  }
})

test('abandoning a contradictory preparation uses the current production reason', async () => {
  const fixture = await startFixtureServer()
  try {
    const parked = (await (await fetch(`${fixture.base}/api/runs/parked`)).json()) as {
      blocks: { run_id: string; axis: string }[]
    }
    const runId = parked.blocks.find((block) => block.axis === 'preparation')?.run_id
    expect.assert(runId)
    const response = await fetch(
      `${fixture.base}/api/admin/runs/${encodeURIComponent(runId)}/abandon`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-review-runs-admin-token': 'fixture-admin-token'
        },
        body: JSON.stringify({
          reason: 'records contradict the execution outcome'
        })
      }
    )
    expect(response.status).toBe(200)
    const { run } = (await response.json()) as {
      run: {
        preparation: { status: string; failure_code: string }
        notices: { reason_code: string }[]
      }
    }
    expect(run.preparation.status).toBe('failed')
    expect(run.preparation.failure_code).toBe('PREPARATION_ABANDONED_BY_OPERATOR')
    expect(run.notices[0]?.reason_code).toBe('PREPARATION_ABANDONED_BY_OPERATOR')
  } finally {
    await fixture.close()
  }
})
