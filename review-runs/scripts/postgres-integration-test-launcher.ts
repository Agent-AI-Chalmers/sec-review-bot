// Runs PostgreSQL-backed integration tests against an explicitly supplied disposable database
// or a short-lived local Docker PostgreSQL instance, then always removes any instance it owns.
import crypto from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { parse } from 'yaml'

const scriptDirectory = import.meta.dirname
const reviewRunsDirectory = path.resolve(scriptDirectory, '..')
const repositoryDirectory = path.resolve(reviewRunsDirectory, '..')
const suppliedDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

async function configuredPostgresImage(): Promise<string> {
  if (process.env.TEST_POSTGRES_IMAGE !== undefined)
    return process.env.TEST_POSTGRES_IMAGE

  // Compose owns the deployed PostgreSQL version. The ephemeral test database
  // deliberately uses that same image rather than maintaining a second tag.
  const compose = parse(
    await readFile(path.join(repositoryDirectory, 'compose.yaml'), 'utf8')
  ) as { services?: { postgres?: { image?: unknown } } }
  const image = compose.services?.postgres?.image
  if (typeof image !== 'string' || image.trim() === '')
    throw new Error('compose.yaml must define services.postgres.image.')
  return image
}

function run(
  command: string,
  args: string[],
  environment = process.env
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: reviewRunsDirectory,
      env: environment,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve()
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${
            signal === null ? `code ${code}` : `signal ${signal}`
          }.`
        )
      )
    })
  })
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(command, args, {
      cwd: reviewRunsDirectory,
      stdio: ['ignore', 'pipe', 'inherit']
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) return resolve(output.trim())
      reject(
        new Error(`${command} ${args.join(' ')} exited with code ${code}.`)
      )
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForPostgres(containerName: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await capture('docker', [
        'exec',
        containerName,
        'pg_isready',
        '--username=postgres',
        '--dbname=postgres'
      ])
      return
    } catch {
      await delay(250)
    }
  }
  throw new Error('Timed out waiting for temporary PostgreSQL to become ready.')
}

async function integrationTestFiles(): Promise<string[]> {
  const directory = path.join(reviewRunsDirectory, 'test', 'integration')
  return (await readdir(directory))
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => path.join('test', 'integration', entry))
    .sort()
}

async function runTests(databaseUrl: string): Promise<void> {
  await run('pnpm', ['run', 'build'])
  await run(
    process.execPath,
    ['--import', 'tsx', '--test', ...(await integrationTestFiles())],
    { ...process.env, TEST_DATABASE_URL: databaseUrl }
  )
}

async function main(): Promise<void> {
  if (suppliedDatabaseUrl !== undefined) {
    await runTests(suppliedDatabaseUrl)
    return
  }

  const containerName = `review-runs-integration-${crypto.randomUUID()}`
  const password = crypto.randomBytes(24).toString('hex')
  const postgresImage = await configuredPostgresImage()
  let containerStarted = false
  try {
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
      postgresImage
    ])
    containerStarted = true
    await waitForPostgres(containerName)
    const address = await capture('docker', ['port', containerName, '5432/tcp'])
    const hostPort = address.replace(/^.*:/, '')
    if (!/^\d+$/.test(hostPort))
      throw new Error(
        `Docker returned an invalid PostgreSQL address: ${address}`
      )
    await runTests(
      `postgresql://postgres:${password}@127.0.0.1:${hostPort}/postgres`
    )
  } finally {
    if (containerStarted)
      await run('docker', ['rm', '--force', containerName]).catch(
        () => undefined
      )
  }
}

await main()
