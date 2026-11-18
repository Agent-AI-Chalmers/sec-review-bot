import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const mode = process.argv[2]
if (mode !== 'unit' && mode !== 'integration') {
  throw new Error('Usage: node scripts/test-runner.mjs <unit|integration>')
}

const require = createRequire(import.meta.url)
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

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
  await writeFile(env.GIT_CONFIG_GLOBAL, `[core]\n\tattributesFile = ${JSON.stringify(devNull)}\n`)
  result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--project', mode, ...process.argv.slice(3)],
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
