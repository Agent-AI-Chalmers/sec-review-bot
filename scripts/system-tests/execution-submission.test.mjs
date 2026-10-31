// Exercises the Review Runs -> Execution Gateway -> Temporal boundary against a disposable
// Temporal service. This intentionally stops before worker execution, which belongs to the
// separately configured agents runtime and requires model, workspace, and object-store inputs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const repositoryDirectory = path.resolve(import.meta.dirname, '../..')
const gatewayDirectory = path.join(
  repositoryDirectory,
  'services',
  'execution-gateway',
)
const reviewRunsDirectory = path.join(
  repositoryDirectory,
  'services',
  'review-runs',
)
const requireFromGateway = createRequire(
  path.join(gatewayDirectory, 'package.json'),
)
const { parse } = requireFromGateway('yaml')

// Keep child-process failures visible and fail the test on either a non-zero exit or signal.
// Package builds and Docker lifecycle commands use this same boundary so none can fail silently.
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve()
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${
            signal === null ? `code ${code}` : `signal ${signal}`
          }.`,
        ),
      )
    })
  })
}

// Capture only commands whose output becomes test input, such as Docker's assigned host port.
// Readiness retries may suppress stderr, while one-shot commands retain it for diagnostics.
function capture(command, args, { stderr = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(command, args, {
      cwd: repositoryDirectory,
      stdio: ['ignore', 'pipe', stderr],
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) return resolve(output.trim())
      reject(
        new Error(`${command} ${args.join(' ')} exited with code ${code}.`),
      )
    })
  })
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function temporalImage() {
  if (process.env.TEST_TEMPORAL_IMAGE) return process.env.TEST_TEMPORAL_IMAGE
  // Compose owns the deployed image choice. Reusing it here prevents the system test from
  // validating against a Temporal version different from the repository's local deployment.
  const compose = parse(
    await readFile(path.join(repositoryDirectory, 'compose.yaml'), 'utf8'),
  )
  const image = compose?.services?.temporal?.image
  if (typeof image !== 'string' || image.trim() === '')
    throw new Error('compose.yaml must define services.temporal.image.')
  return image
}

// Temporal may accept the container process before its gRPC service is ready. Probe through the
// image's own CLI so the test starts only after the same endpoint used by the SDK is healthy.
async function waitForTemporal(containerName) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await capture(
        'docker',
        [
          'exec',
          containerName,
          'temporal',
          'operator',
          'cluster',
          'health',
          '--address',
          '127.0.0.1:7233',
        ],
        { stderr: 'ignore' },
      )
      return
    } catch {
      await delay(250)
    }
  }
  throw new Error('Timed out waiting for temporary Temporal to become ready.')
}

// The system test imports production JavaScript from dist rather than source through a TS loader.
// Building both owners first therefore validates their real packaging and generated contract copy.
async function buildPackages() {
  await Promise.all([
    run('pnpm', ['run', 'build'], { cwd: gatewayDirectory }),
    run('pnpm', ['run', 'build'], { cwd: reviewRunsDirectory }),
  ])
}

// A random host port permits local runs alongside an existing Temporal deployment and parallel CI
// jobs. The caller owns the returned container and removes it after the assertions finish.
async function startTemporaryTemporal() {
  const containerName = `execution-submission-system-${crypto.randomUUID()}`
  await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::7233',
    await temporalImage(),
    'server',
    'start-dev',
    '--ip',
    '0.0.0.0',
  ])
  try {
    await waitForTemporal(containerName)
    const address = await capture('docker', ['port', containerName, '7233/tcp'])
    const hostPort = address.replace(/^.*:/, '')
    if (!/^\d+$/.test(hostPort))
      throw new Error(`Docker returned an invalid Temporal address: ${address}`)
    return { address: `127.0.0.1:${hostPort}`, containerName }
  } catch (error) {
    await run('docker', ['rm', '--force', containerName]).catch(() => undefined)
    throw error
  }
}

// This is the cross-service behavior under test: the production Review Runs HTTP client talks to
// the real Gateway route handlers, which persist workflow identity in a real Temporal service.
// No worker is started, so RUNNING is the stable expected state rather than a synthetic result.
async function exerciseSubmissionBoundary(temporalAddress) {
  const token = `system-${crypto.randomUUID()}`
  const runId = `system-${crypto.randomUUID()}`
  process.env.NODE_ENV = 'test'
  process.env.TEMPORAL_ADDRESS = temporalAddress
  process.env.EXECUTION_API_TOKEN = token
  process.env.EXECUTION_API_REQUEST_RETRIES = '0'

  const [{ createApp }, { TemporalExecutionStore }, executionClient] =
    await Promise.all([
      import('../../services/execution-gateway/dist/server.js'),
      import('../../services/execution-gateway/dist/temporal-execution-store.js'),
      import('../../services/review-runs/dist/execution-client.js'),
    ])
  const store = await TemporalExecutionStore.connect()
  const app = await createApp({ store, token })

  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.EXECUTION_API_URL = address
    const input = JSON.parse(
      await readFile(
        path.join(
          repositoryDirectory,
          'contracts',
          'execution-api',
          'v1',
          'fixtures',
          'issue-review-input.json',
        ),
        'utf8',
      ),
    )

    await executionClient.submitExecutionRun({
      workflow: 'issue-review',
      run_id: runId,
      input,
    })
    // Review Runs may replay an uncertain submission. The second request must resolve to the same
    // Temporal workflow through the Gateway's fingerprint check instead of creating a conflict.
    await executionClient.submitExecutionRun({
      workflow: 'issue-review',
      run_id: runId,
      input,
    })

    assert.deepEqual(
      await executionClient.getExecutionRunStatus(runId, 'issue-review'),
      {
        run_id: runId,
        workflow: 'issue-review',
        status: 'running',
      },
    )
  } finally {
    await app.close()
    await store.close()
  }
}

test('Review Runs submits and reads a run through Execution Gateway', async () => {
  await buildPackages()
  // CI or a developer may explicitly supply an already-isolated test service. Do not inherit the
  // ordinary deployment address: a system test must never create workflows in a shared Temporal.
  // Without the test-only override, this test owns a short-lived container and its cleanup.
  const suppliedAddress = process.env.TEST_TEMPORAL_ADDRESS
  if (suppliedAddress) {
    await exerciseSubmissionBoundary(suppliedAddress)
    return
  }

  const temporary = await startTemporaryTemporal()
  try {
    await exerciseSubmissionBoundary(temporary.address)
  } finally {
    await run('docker', ['rm', '--force', temporary.containerName]).catch(
      () => undefined,
    )
  }
})
