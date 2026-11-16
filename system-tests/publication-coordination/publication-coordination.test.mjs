// GitHub Integration's real publish path against a real Review Runs store over HTTP.
//
// Connector unit tests mock the Review Runs store, so they see which calls were made but not what
// the store did with them: a call that also concluded the publication, or one that never spent a
// reconciliation budget, passed every mock. Each test here drives a publication through the
// compiled connector code and asserts the outcome Review Runs actually recorded.
//
// The test builds both participants. It uses TEST_DATABASE_URL when supplied, and otherwise owns
// a short-lived PostgreSQL container from compose.yaml's image.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repositoryDirectory = path.resolve(import.meta.dirname, '../..')
const integrationDirectory = path.join(
  repositoryDirectory,
  'apps',
  'github-integration'
)
const reviewRunsDirectory = path.join(
  repositoryDirectory,
  'services',
  'review-runs'
)
const fromReviewRuns = createRequire(
  path.join(reviewRunsDirectory, 'package.json')
)
const fromIntegration = createRequire(
  path.join(integrationDirectory, 'package.json')
)
const Fastify = fromReviewRuns('fastify')
const { Octokit } = fromIntegration('octokit')
const { parse } = fromIntegration('yaml')

function run(command, args, cwd = repositoryDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} ${args.join(' ')} exited with code ${code}.`)
          )
    )
  })
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (output += chunk))
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(`${command} ${args.join(' ')} exited with code ${code}.`)
          )
    )
  })
}

// A random host port permits local runs alongside a deployment and parallel CI jobs. Never inherit
// an ordinary deployment DATABASE_URL: this test writes runs and must own its database.
async function startTemporaryPostgres() {
  const compose = parse(
    await readFile(path.join(repositoryDirectory, 'compose.yaml'), 'utf8')
  )
  const image =
    process.env.TEST_POSTGRES_IMAGE ?? compose?.services?.postgres?.image
  if (typeof image !== 'string')
    throw new Error('compose.yaml must define services.postgres.image.')
  const containerName = `publication-coordination-system-${randomUUID()}`
  const password = randomUUID()
  await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    image
  ])
  try {
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        // Probe TCP so readiness cannot pass on the image's Unix-socket-only bootstrap server.
        await capture('docker', [
          'exec',
          containerName,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres'
        ])
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    const port = (
      await capture('docker', ['port', containerName, '5432/tcp'])
    ).replace(/^.*:/, '')
    return {
      url: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
      containerName
    }
  } catch (error) {
    await run('docker', ['rm', '--force', containerName]).catch(() => undefined)
    throw error
  }
}

let databaseUrl = process.env.TEST_DATABASE_URL
let temporaryContainer
let modules
test.before(async () => {
  // Built once, so the tests exercise the real packaging and generated contract copy.
  await Promise.all([
    run('pnpm', ['run', 'build'], integrationDirectory),
    run('pnpm', ['run', 'build'], reviewRunsDirectory)
  ])
  if (databaseUrl === undefined) {
    const temporary = await startTemporaryPostgres()
    databaseUrl = temporary.url
    temporaryContainer = temporary.containerName
  }
  const load = (relative) => import(path.join(repositoryDirectory, relative))
  modules = {
    ...(await load('apps/github-integration/dist/review-runs/client.js')),
    ...(await load(
      'apps/github-integration/dist/reviews/repositories/publish.js'
    )),
    ...(await load(
      'apps/github-integration/dist/reviews/shared/settle-exhausted-step.js'
    )),
    ...(await load(
      'services/review-runs/dist/persistence/review-run-store.js'
    )),
    ...(await load('services/review-runs/dist/http/server-surface.js'))
  }
})
test.after(async () => {
  if (temporaryContainer !== undefined)
    await run('docker', ['rm', '--force', temporaryContainer]).catch(
      () => undefined
    )
})

const SERVICE_TOKEN = 'seam-service-token'
const REPO = {
  owner_login: 'octo',
  repo_name: 'example',
  repo_full_name: 'octo/example',
  default_branch: 'main'
}

/** Review Runs' real routes and store on a loopback port, with the connector's client pointed at
 * it. Each call uses its own connector id, so tests never see each other's runs. */
async function startReviewRuns(t) {
  const connectorId = `seam:${randomUUID()}`
  const store = new modules.ReviewRunStore({
    connectionString: databaseUrl,
    connectorId
  })
  await store.initialize()
  const app = Fastify(modules.REVIEW_RUNS_FASTIFY_OPTIONS)
  await modules.registerReviewRunsRoutes(app, {
    store,
    serviceToken: SERVICE_TOKEN,
    readToken: 'seam-read-token'
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const saved = {
    url: process.env.REVIEW_RUNS_SERVICE_URL,
    token: process.env.REVIEW_RUNS_SERVICE_TOKEN
  }
  process.env.REVIEW_RUNS_SERVICE_URL = `http://127.0.0.1:${app.server.address().port}`
  process.env.REVIEW_RUNS_SERVICE_TOKEN = SERVICE_TOKEN
  t.after(async () => {
    process.env.REVIEW_RUNS_SERVICE_URL = saved.url
    process.env.REVIEW_RUNS_SERVICE_TOKEN = saved.token
    await app.close()
    await store.close()
  })
  return store
}

/** One run whose execution succeeded and whose publication this test owns, with its steps. */
async function publishingRun(store, stepKeys) {
  const runId = randomUUID()
  const admitted = await store.admissions.create({
    workflow: 'repository-review',
    run_id: runId,
    publish_context: {}
  })
  await store.submissionTransitions.markQueued(
    runId,
    admitted.preparation_token,
    {}
  )
  await store.executions.recordExecutionSuccess(
    runId,
    { run_id: runId },
    { status: 'unavailable' }
  )
  const token = await store.publicationClaims.claim(runId)
  assert.ok(token)
  await store.publications.initializePublicationSteps(runId, token, stepKeys)
  return { runId, token }
}

/** Spend a step's attempts so its next claim enters reconciliation. */
async function exhaust(store, runId, token, stepKey) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await store.publications.requirePublicationStepClaim(runId, token, stepKey)
    await store.publications.failPublicationStep(
      runId,
      token,
      stepKey,
      { message: 'response lost' },
      { retry: true }
    )
  }
}

/** An Octokit whose transport answers from `respond`; nothing leaves the process. */
function github(respond) {
  return new Octokit({
    auth: 'seam-token',
    throttle: { enabled: false },
    retry: { enabled: false },
    request: {
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url)
        const { status, body } = respond(
          (init?.method ?? 'GET').toUpperCase(),
          url
        )
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        })
      }
    }
  })
}

function delivery(id) {
  return { delivery_id: id, case_ids: [], file_changes: [] }
}

async function publish(octokit, runId, token, deliveries, createPullRequest) {
  return await modules.publishDeliveryDraftPrs({
    octokit,
    repo: REPO,
    run_id: runId,
    workspace_ref: 'main',
    deliveries,
    case_results: [],
    event_type: 'manual',
    store: modules.reviewRunsClient,
    claim_token: token,
    assert_publication_claim: async () => {},
    create_delivery_draft_pr: createPullRequest
  })
}

test('a delivery rejected for good leaves the publication to its owner, so later deliveries publish', async (t) => {
  const store = await startReviewRuns(t)
  const [a, b] = ['repository:delivery:a', 'repository:delivery:b']
  const { runId, token } = await publishingRun(store, [a, b])
  const rejected = Object.assign(new Error('Validation Failed'), {
    status: 422,
    response: {
      status: 422,
      headers: {},
      data: { message: 'Validation Failed' }
    }
  })

  const published = await publish(
    github(() => ({ status: 200, body: [] })),
    runId,
    token,
    [delivery('a'), delivery('b')],
    async ({ delivery: current }) => {
      if (current.delivery_id === 'a') throw rejected
      return {
        title: 'b',
        number: 2,
        html_url: 'https://github.test/octo/example/pull/2',
        branch_name: 'seam/b',
        body: '',
        reused: false
      }
    }
  )

  assert.deepEqual(
    published.map((entry) => entry.delivery_id),
    ['b']
  )
  const steps = Object.fromEntries(
    (await store.publications.listPublicationSteps(runId)).map((step) => [
      step.step_key,
      step.status
    ])
  )
  assert.deepEqual(steps, { [a]: 'terminal_failed', [b]: 'succeeded' })
  assert.equal(
    (await store.queries.getRun(runId)).publication.status,
    'publishing',
    'a step failure must not conclude the publication or take its claim'
  )
})

test('a reconciliation lookup that keeps failing parks the step instead of retrying forever', async (t) => {
  const store = await startReviewRuns(t)
  const step = 'repository:delivery:gone'
  let { runId, token } = await publishingRun(store, [step])
  await exhaust(store, runId, token, step)
  const octokit = github((method, url) =>
    method === 'GET' && url.pathname.endsWith('/pulls')
      ? { status: 502, body: { message: 'Bad Gateway' } }
      : { status: 200, body: {} }
  )

  let passes = 0
  for (; passes < 10; passes += 1) {
    if (
      (await store.publications.listPublicationSteps(runId))[0].status ===
      'disconnected'
    )
      break
    // One connector pass: the lookup fails, the publication is retried and claimed again.
    await assert.rejects(
      publish(octokit, runId, token, [delivery('gone')], async () => {
        throw new Error('an unreconciled step must not create a pull request')
      })
    )
    if (
      await store.publications.fail(
        runId,
        token,
        { code: 'GITHUB_TRANSIENT', message: 'Bad Gateway' },
        { retry: true }
      )
    ) {
      token = await store.publicationClaims.claim(runId)
      assert.ok(token)
    }
  }

  assert.ok(passes <= 3, `the step parked after ${passes} passes`)
  assert.equal(
    (await store.publications.listPublicationSteps(runId))[0].status,
    'disconnected'
  )
  assert.ok(
    (await store.queries.listParkedRuns()).some(
      (parked) => parked.run_id === runId
    ),
    'the run reaches the operator queue'
  )
})

test('a reconciliation lookup that fails for good ends its step without settling it as absent', async (t) => {
  const store = await startReviewRuns(t)
  const [gone, next] = ['repository:delivery:gone', 'repository:delivery:next']
  const { runId, token } = await publishingRun(store, [gone, next])
  await exhaust(store, runId, token, gone)
  const octokit = github((method, url) =>
    method === 'GET' && url.pathname.endsWith('/pulls')
      ? { status: 404, body: { message: 'Not Found' } }
      : { status: 200, body: {} }
  )

  const published = await publish(
    octokit,
    runId,
    token,
    [delivery('gone'), delivery('next')],
    async () => ({
      title: 'next',
      number: 3,
      html_url: 'https://github.test/octo/example/pull/3',
      branch_name: 'seam/next',
      body: '',
      reused: false
    })
  )

  assert.deepEqual(
    published.map((entry) => entry.delivery_id),
    ['next']
  )
  const steps = await store.publications.listPublicationSteps(runId)
  const goneStep = steps.find((step) => step.step_key === gone)
  assert.equal(goneStep.status, 'terminal_failed')
  assert.equal(
    goneStep.remote_object_id,
    null,
    'a failed lookup is never settled as found'
  )
  assert.equal(steps.find((step) => step.step_key === next).status, 'succeeded')
})

test('an exhausted delivery whose pull request already exists is settled as published', async (t) => {
  const store = await startReviewRuns(t)
  const step = 'repository:delivery:posted'
  const { runId, token } = await publishingRun(store, [step])
  await exhaust(store, runId, token, step)
  const octokit = github((method, url) =>
    method === 'GET' && url.pathname.endsWith('/pulls')
      ? {
          status: 200,
          body: [
            { number: 7, html_url: 'https://github.test/octo/example/pull/7' }
          ]
        }
      : { status: 200, body: {} }
  )

  const published = await publish(
    octokit,
    runId,
    token,
    [delivery('posted')],
    async () => {
      throw new Error('a reconciled step must not create a second pull request')
    }
  )

  assert.deepEqual(
    published.map((entry) => [entry.delivery_id, entry.html_url]),
    [['posted', 'https://github.test/octo/example/pull/7']]
  )
  const [settled] = await store.publications.listPublicationSteps(runId)
  assert.equal(settled.status, 'succeeded')
  assert.equal(
    settled.remote_object_url,
    'https://github.test/octo/example/pull/7'
  )
  assert.equal(
    (await store.queries.getRun(runId)).publication.status,
    'publishing',
    'settling the only uncertain step returns the axis to publishing'
  )
})

test('a lookup failure whose report committed but lost its response spends the budget once', async (t) => {
  const store = await startReviewRuns(t)
  const step = 'repository:delivery:flaky'
  const { runId, token } = await publishingRun(store, [step])
  await exhaust(store, runId, token, step)
  // The first claim after exhaustion moves the step to `uncertain`; reconciliation starts there.
  await assert.rejects(
    store.publications.requirePublicationStepClaim(runId, token, step)
  )
  // The first report reaches Review Runs and commits, then its response is lost.
  let reports = 0
  const lossy = Object.create(modules.reviewRunsClient)
  lossy.failPublicationStep = async (...args) => {
    reports += 1
    const recorded = await modules.reviewRunsClient.failPublicationStep(...args)
    if (reports === 1)
      throw Object.assign(new Error('Review Runs response lost'), {
        status: 504
      })
    return recorded
  }

  const outcome = await modules.settleExhaustedStep({
    store: lossy,
    runId,
    token,
    stepKey: step,
    find: async () => {
      throw Object.assign(new Error('GitHub answered 502'), { status: 502 })
    }
  })
  assert.equal(outcome.outcome, 'lookup_failed')
  assert.equal(outcome.recording, 'accepted')
  assert.match(String(outcome.error), /502/)

  assert.equal(reports, 2, 'the lost report is retried')
  const [after] = await store.publications.listPublicationSteps(runId)
  assert.equal(after.status, 'uncertain')
  assert.equal(
    after.unresolved_recovery_count,
    1,
    'one failed lookup spends one unit of the reconciliation budget'
  )
})
