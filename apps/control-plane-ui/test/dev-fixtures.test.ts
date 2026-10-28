import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { Plugin } from 'vite'

import { devFixtures } from '../scripts/dev-fixtures/index.js'

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
  assert(typeof configureServer === 'function')
  let middleware:
    | ((
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void
      ) => void)
    | undefined
  const fakeServer = {
    middlewares: {
      use(
        handler: (
          request: IncomingMessage,
          response: ServerResponse,
          next: () => void
        ) => void
      ): void {
        middleware = handler
      }
    }
  }
  // `devFixtures` never reads `this`, so invoking the hook with the fake server alone is
  // faithful; the cast only satisfies Vite's `this: MinimalPluginContext` signature.
  const runConfigureServer = configureServer as (
    server: typeof fakeServer
  ) => void
  runConfigureServer(fakeServer)
  assert(middleware !== undefined)
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
  assert(address && typeof address === 'object')
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
  await assert.doesNotReject(
    () => import('../scripts/dev-fixtures/runs/generate.js')
  )
})

test('dev fixtures distinguish a statistics snapshot from no snapshot', async () => {
  const { runs, stepsByRun } =
    await import('../scripts/dev-fixtures/runs/generate.js')
  const completed = runs.filter((run) => run.execution.status === 'succeeded')
  const active = runs.find((run) => run.execution.status === 'running')
  const agentsFor = (
    workflow: (typeof completed)[number]['workflow']
  ): string[] => {
    const run = completed.find((candidate) => candidate.workflow === workflow)
    assert(run !== undefined)
    const statistics = run.execution_statistics
    assert(statistics !== null)
    return [...new Set(statistics.groups.map((group) => group.agent_name))]
  }
  assert.deepStrictEqual(agentsFor('issue-review'), [
    'issue-analyzer',
    'issue-mitigator',
    'issue-verifier'
  ])
  assert.deepStrictEqual(agentsFor('pull-request-review'), [
    'pull-request-analyzer',
    'pull-request-mitigator',
    'pull-request-verifier'
  ])
  assert.deepStrictEqual(agentsFor('repository-review'), [
    'repository-discovery',
    'repository-triager',
    'repository-analyzer',
    'repository-cvss-v4-scorer',
    'repository-mitigator',
    'repository-verifier',
    'repository-delivery-planner',
    'patch-synthesizer'
  ])
  const repositoryRun = completed.find(
    (run) => run.workflow === 'repository-review'
  )
  assert(repositoryRun !== undefined)
  const patchDeliveryIds = repositoryRun.execution_statistics?.groups
    .filter((group) => group.agent_name === 'patch-synthesizer')
    .map((group) => group.delivery_id)
  assert(patchDeliveryIds !== undefined)
  assert(patchDeliveryIds.length >= 2)
  const publicationDeliveryIds = (stepsByRun.get(repositoryRun.run_id) ?? [])
    .map((step) => step.step_key.match(/^repository:delivery:(.+)$/)?.[1])
    .filter((deliveryId): deliveryId is string => deliveryId !== undefined)
  assert.deepStrictEqual(patchDeliveryIds, publicationDeliveryIds)
  for (const run of completed) {
    const statistics = run.execution_statistics
    assert(statistics !== null)
    const usages = [
      statistics.token_usage,
      ...statistics.groups.map((group) => group.token_usage)
    ]
    for (const usage of usages) {
      if (
        usage.input_tokens !== null &&
        usage.output_tokens !== null &&
        usage.total_tokens !== null
      ) {
        assert.strictEqual(
          usage.total_tokens,
          usage.input_tokens + usage.output_tokens,
          'fixture total_tokens must equal inclusive input_tokens + output_tokens'
        )
      }
      if (
        usage.input_tokens !== null &&
        usage.cache_read_input_tokens !== null
      ) {
        assert(
          usage.cache_read_input_tokens <= usage.input_tokens,
          'fixture cache_read_input_tokens must be a subset of input_tokens'
        )
      }
      if (
        usage.input_tokens !== null &&
        usage.cache_creation_input_tokens !== null
      ) {
        assert(
          usage.cache_creation_input_tokens <= usage.input_tokens,
          'fixture cache_creation_input_tokens must be a subset of input_tokens'
        )
      }
      if (usage.output_tokens !== null && usage.reasoning_tokens !== null) {
        assert(
          usage.reasoning_tokens <= usage.output_tokens,
          'fixture reasoning_tokens must be a subset of output_tokens'
        )
      }
    }
  }
  for (const workflow of ['issue-review', 'pull-request-review'] as const) {
    const workflowRuns = completed.filter((run) => run.workflow === workflow)
    assert(
      workflowRuns.some((run) =>
        run.execution_statistics?.groups.some(
          (group) => group.pass_kind === 'feedback'
        )
      ),
      `${workflow} fixtures must include a feedback loop`
    )
    assert(
      workflowRuns.some(
        (run) =>
          !run.execution_statistics?.groups.some(
            (group) => group.pass_kind === 'feedback'
          )
      ),
      `${workflow} fixtures must include a run without feedback`
    )
  }
  assert.strictEqual(active?.execution_statistics, null)
})

test('dev fixtures track sign-out so the console reaches the sign-in form', async () => {
  // The fixtures exist to show the console's real screens with no access token, so
  // they start signed in — a run list must be reachable before any session call.
  const fixture = await startFixtureServer()
  try {
    const signedIn = await fetch(`${fixture.base}/api/runs?limit=1`)
    assert.strictEqual(signedIn.status, 200)

    // Signing out mirrors the BFF: 204, and every later API call is unauthorized so
    // the console switches to its sign-in form rather than reloading the run list.
    const signOut = await fetch(`${fixture.base}/api/session`, {
      method: 'DELETE'
    })
    assert.strictEqual(signOut.status, 204)

    const afterSignOut = await fetch(`${fixture.base}/api/runs?limit=1`)
    assert.strictEqual(afterSignOut.status, 401)
    assert.deepStrictEqual(await afterSignOut.json(), { error: 'unauthorized' })

    // Signing back in restores the run list: POST is the only way to become signed in.
    const signIn = await fetch(`${fixture.base}/api/session`, {
      method: 'POST'
    })
    assert.strictEqual(signIn.status, 204)

    const afterSignIn = await fetch(`${fixture.base}/api/runs?limit=1`)
    assert.strictEqual(afterSignIn.status, 200)
  } finally {
    await fixture.close()
  }
})

test('dev fixtures leave non-API requests to the next middleware', async () => {
  // The middleware must not claim routes outside `/api/`; the fixture server's `next`
  // handler answers 404, which stands in for Vite's own asset middleware.
  const fixture = await startFixtureServer()
  try {
    const asset = await fetch(`${fixture.base}/index.html`)
    assert.strictEqual(asset.status, 404)
  } finally {
    await fixture.close()
  }
})

test('dev fixtures serve memory actions as downloads', async () => {
  const fixture = await startFixtureServer()
  try {
    for (const [path, filename] of [
      [
        '/api/memory/revisions/2/artifact',
        'attachment; filename="memory-tree.v1.tar.zst"'
      ],
      [
        '/api/memory/revisions/2/transcript',
        'attachment; filename="memory-transcript.v1.jsonl.zst"'
      ],
      [
        '/api/memory/extractions/fixture-extraction-2/transcript',
        'attachment; filename="memory-transcript.v1.jsonl.zst"'
      ]
    ] as const) {
      const response = await fetch(`${fixture.base}${path}`)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(
        response.headers.get('content-type'),
        'application/octet-stream'
      )
      assert.strictEqual(response.headers.get('content-disposition'), filename)
      assert.ok((await response.arrayBuffer()).byteLength > 0)
    }
  } finally {
    await fixture.close()
  }
})

test('dev fixtures expose stable full-page load-error scenarios', async () => {
  const fixture = await startFixtureServer()
  try {
    for (const [path, status, error] of [
      [
        '/api/memory/revisions/404/content',
        422,
        'invalid_memory_tree_artifact'
      ],
      [
        '/api/memory/revisions/404/transcript/content',
        503,
        'memory_catalog_unavailable'
      ],
      [
        '/api/runs/fixture-artifact-load-error/artifact/content',
        503,
        'review_runs_unavailable'
      ]
    ] as const) {
      const response = await fetch(`${fixture.base}${path}`)
      assert.strictEqual(response.status, status)
      assert.deepStrictEqual(await response.json(), { error })
    }

    const download = await fetch(
      `${fixture.base}/api/memory/revisions/404/artifact`
    )
    assert.strictEqual(download.status, 200)
    assert.strictEqual(
      download.headers.get('content-disposition'),
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
    const first = await (
      await fetch(`${fixture.base}/api/runs?limit=50`)
    ).json()
    const stamps = first.runs.map(
      (run: { created_at: string }) => run.created_at
    )
    assert.deepStrictEqual(
      stamps,
      [...stamps].sort().reverse(),
      'the list is newest-first, which is what the cursor walks'
    )
    assert.ok(
      first.next_cursor,
      'sixty-two fixtures must not fit one page of fifty'
    )

    const second = await (
      await fetch(
        `${fixture.base}/api/runs?limit=50&cursor=${first.next_cursor}`
      )
    ).json()
    const firstIds = new Set(
      first.runs.map((run: { run_id: string }) => run.run_id)
    )
    assert.ok(second.runs.length > 0, 'the cursor must return a second page')
    for (const run of second.runs as { run_id: string }[]) {
      assert.ok(
        !firstIds.has(run.run_id),
        `${run.run_id} appears on both pages`
      )
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
    const unfiltered = await (
      await fetch(`${fixture.base}/api/runs?limit=1`)
    ).json()
    const newest = unfiltered.runs[0]
    assert.ok(newest, 'the fixtures must serve at least one run')
    assert.ok(
      !(
        newest.workflow === 'repository-review' &&
        newest.publication.status === 'published'
      ),
      'the newest run must not already look like the published repository filter'
    )
  } finally {
    await fixture.close()
  }
})

test('run fixtures filter by source platform', async () => {
  const fixture = await startFixtureServer()
  try {
    const github = await (
      await fetch(`${fixture.base}/api/runs?source_platform=github&limit=1`)
    ).json()
    assert.strictEqual(github.runs[0]?.source_platform, 'github')

    const gitlab = await (
      await fetch(`${fixture.base}/api/runs?source_platform=gitlab&limit=1`)
    ).json()
    assert.strictEqual(gitlab.runs[0]?.source_platform, 'gitlab')

    const unknown = await (
      await fetch(`${fixture.base}/api/runs?source_platform=unknown&limit=1`)
    ).json()
    assert.strictEqual(unknown.runs[0]?.source_platform, 'unknown')
  } finally {
    await fixture.close()
  }
})

test('memory fixtures form one coherent provenance graph', async () => {
  const fixture = await startFixtureServer()
  try {
    const [extractions, observations, overview, revisions] = await Promise.all([
      fetch(`${fixture.base}/api/memory/extractions?limit=100`).then(
        (response) => response.json()
      ),
      fetch(`${fixture.base}/api/memory/observations?limit=100`).then(
        (response) => response.json()
      ),
      fetch(`${fixture.base}/api/memory/overview?range=30d`).then((response) =>
        response.json()
      ),
      fetch(`${fixture.base}/api/memory/revisions?limit=100`).then((response) =>
        response.json()
      )
    ])
    type FixtureExtraction = {
      extraction_id: string
      source_run_id: string
      source_unit_id: string
      observation: { body_markdown: string } | null
    }
    const extractionById = new Map<string, FixtureExtraction>(
      extractions.extractions.map(
        (record: FixtureExtraction) => [record.extraction_id, record] as const
      )
    )

    assert.strictEqual(extractions.next_cursor, null)
    assert.strictEqual(extractions.extractions.length, 6)
    assert.strictEqual(observations.next_cursor, null)
    assert.strictEqual(observations.observations.length, 3)
    assert.strictEqual(
      overview.totals.completed_extraction_count,
      extractions.extractions.length
    )
    assert.strictEqual(
      overview.totals.observation_count,
      observations.observations.length
    )
    assert.strictEqual(
      overview.totals.pending_observation_count +
        overview.totals.consumed_observation_count,
      observations.observations.length
    )
    assert.strictEqual(
      overview.totals.units_with_observation_count +
        overview.totals.units_without_observation_count,
      overview.totals.extracted_unit_count
    )
    assert.strictEqual(
      overview.workflows.reduce(
        (total: number, workflow: { extracted_unit_count: number }) =>
          total + workflow.extracted_unit_count,
        0
      ),
      overview.totals.extracted_unit_count
    )

    for (const observation of observations.observations as Array<{
      extraction_id: string
      source_run_id: string
      source_unit_id: string
      body_markdown: string
      consumed_revision: number | null
    }>) {
      const extraction = extractionById.get(observation.extraction_id)
      assert(extraction, `${observation.extraction_id} must exist`)
      assert.strictEqual(extraction.source_run_id, observation.source_run_id)
      assert.strictEqual(extraction.source_unit_id, observation.source_unit_id)
      assert.strictEqual(
        extraction.observation?.body_markdown,
        observation.body_markdown
      )

      const runResponse = await fetch(
        `${fixture.base}/api/runs/${encodeURIComponent(observation.source_run_id)}`
      )
      assert.strictEqual(runResponse.status, 200)
      const { run } = await runResponse.json()
      assert.strictEqual(run.source_platform, 'github')
      assert.strictEqual(run.execution.status, 'succeeded')
      assert.strictEqual(run.publication.status, 'published')
      assert.strictEqual(run.artifact_storage?.status, 'available')

      if (observation.consumed_revision !== null) {
        const revision = revisions.revisions.find(
          (candidate: { revision: number }) =>
            candidate.revision === observation.consumed_revision
        )
        assert(
          revision,
          'a consumed observation must name an existing revision'
        )
        assert.strictEqual(revision.source.kind, 'maintenance')
        assert.ok(
          revision.source.extraction_ids.includes(observation.extraction_id)
        )
      }
    }

    for (const revision of revisions.revisions as Array<{
      source:
        | { kind: 'maintenance'; extraction_ids: string[] }
        | { kind: 'operator'; operation_id: string; actor: unknown }
    }>) {
      if (revision.source.kind === 'maintenance') {
        for (const extractionId of revision.source.extraction_ids) {
          const observation = observations.observations.find(
            (candidate: { extraction_id: string }) =>
              candidate.extraction_id === extractionId
          )
          assert(
            observation,
            `${extractionId} consumed by a revision must have an observation`
          )
        }
      } else {
        assert.ok(revision.source.operation_id)
        assert.ok(revision.source.actor)
      }
    }
  } finally {
    await fixture.close()
  }
})
