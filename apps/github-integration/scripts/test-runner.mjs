import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
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

const root = mode === 'integration' ? resolve('test/integration') : resolve('test')
const excludedDirectory = mode === 'unit' ? resolve('test/integration') : null
const files = (await collectTests(root, excludedDirectory)).sort()
if (files.length === 0) throw new Error(`No ${mode} tests found in ${root}`)

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit'
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
