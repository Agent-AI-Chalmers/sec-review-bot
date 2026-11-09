import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { devNull, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const mode = process.argv[2]
if (mode !== 'unit' && mode !== 'integration') {
  throw new Error('Usage: node scripts/test-runner.mjs <unit|integration>')
}

async function collectTests(directory, excludedDirectory = null) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory() && path !== excludedDirectory)
      files.push(...(await collectTests(path, excludedDirectory)))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

const root =
  mode === 'integration' ? resolve('test/integration') : resolve('test')
const excludedDirectory = mode === 'unit' ? resolve('test/integration') : null
const files = (await collectTests(root, excludedDirectory)).sort()
if (files.length === 0) throw new Error(`No ${mode} tests found in ${root}`)

// Fixtures own their Git configuration, including commit identities. Do not
// inherit user/system config or Git environment overrides into their subprocesses.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
)
env.GIT_CONFIG_NOSYSTEM = '1'
env.GIT_CONFIG_SYSTEM = devNull
env.GIT_ATTR_NOSYSTEM = '1'

const configRoot = await mkdtemp(join(tmpdir(), 'github-test-git-'))
let result
try {
  // Git otherwise reads the user's default XDG attributes even without global config.
  env.GIT_CONFIG_GLOBAL = join(configRoot, 'config')
  await writeFile(
    env.GIT_CONFIG_GLOBAL,
    `[core]\n\tattributesFile = ${JSON.stringify(devNull)}\n`
  )
  result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', ...files],
      {
        stdio: 'inherit',
        env
      }
    )
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
} finally {
  await rm(configRoot, { recursive: true, force: true })
}
if (result.signal) process.kill(process.pid, result.signal)
else process.exitCode = result.code ?? 1
