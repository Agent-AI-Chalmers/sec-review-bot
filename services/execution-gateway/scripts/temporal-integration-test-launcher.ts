// Runs Temporal-backed integration tests against an explicitly supplied disposable service
// or a short-lived local Docker Temporal instance, then always removes any instance it owns.
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'yaml'

const scriptDirectory = import.meta.dirname
const gatewayDirectory = path.resolve(scriptDirectory, '..')
const repositoryDirectory = path.resolve(gatewayDirectory, '../..')
// Never inherit the service's ordinary TEMPORAL_ADDRESS: integration tests create workflows and
// must not write into a developer or shared deployment merely because that variable is present.
const suppliedTemporalAddress = process.env.TEST_TEMPORAL_ADDRESS

async function configuredTemporalImage(): Promise<string> {
  if (process.env.TEST_TEMPORAL_IMAGE !== undefined)
    return process.env.TEST_TEMPORAL_IMAGE

  // Compose owns the deployed Temporal version. The ephemeral test service
  // deliberately uses that same image rather than maintaining a second tag.
  const compose = parse(
    await readFile(path.join(repositoryDirectory, 'compose.yaml'), 'utf8'),
  ) as { services?: { temporal?: { image?: unknown } } }
  const image = compose.services?.temporal?.image
  if (typeof image !== 'string' || image.trim() === '')
    throw new Error('compose.yaml must define services.temporal.image.')
  return image
}

function run(
  command: string,
  args: string[],
  environment = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: gatewayDirectory,
      env: environment,
      stdio: 'inherit',
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

function capture(
  command: string,
  args: string[],
  stderr: 'inherit' | 'ignore' = 'inherit',
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(command, args, {
      cwd: gatewayDirectory,
      stdio: ['ignore', 'pipe', stderr],
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForTemporal(containerName: string): Promise<void> {
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
        'ignore',
      )
      return
    } catch {
      await delay(250)
    }
  }
  throw new Error('Timed out waiting for temporary Temporal to become ready.')
}

async function integrationTestFiles(): Promise<string[]> {
  const directory = path.join(gatewayDirectory, 'test', 'integration')
  return (await readdir(directory))
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => path.join('test', 'integration', entry))
    .sort()
}

async function runTests(temporalAddress: string): Promise<void> {
  await run('pnpm', ['run', 'build'])
  await run(
    process.execPath,
    ['--import', 'tsx', '--test', ...(await integrationTestFiles())],
    { ...process.env, TEST_TEMPORAL_ADDRESS: temporalAddress },
  )
}

async function main(): Promise<void> {
  if (suppliedTemporalAddress !== undefined) {
    await runTests(suppliedTemporalAddress)
    return
  }

  const containerName = `execution-gateway-integration-${crypto.randomUUID()}`
  const temporalImage = await configuredTemporalImage()
  let containerStarted = false
  try {
    await run('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::7233',
      temporalImage,
      'server',
      'start-dev',
      '--ip',
      '0.0.0.0',
    ])
    containerStarted = true
    await waitForTemporal(containerName)
    const address = await capture('docker', ['port', containerName, '7233/tcp'])
    const hostPort = address.replace(/^.*:/, '')
    if (!/^\d+$/.test(hostPort))
      throw new Error(`Docker returned an invalid Temporal address: ${address}`)
    await runTests(`127.0.0.1:${hostPort}`)
  } finally {
    if (containerStarted)
      await run('docker', ['rm', '--force', containerName]).catch(
        () => undefined,
      )
  }
}

await main()
