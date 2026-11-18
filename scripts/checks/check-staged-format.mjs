import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const groups = new Map()

// Run from each config's directory so root package exclusions do not hide package files.
for (const file of process.argv.slice(2)) {
  const absolute = path.resolve(root, file)
  const relative = path.relative(root, absolute)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Formatter input is outside the repository: ${file}`)
  }
  if (!existsSync(absolute)) {
    continue
  }
  let directory = path.dirname(absolute)
  while (!existsSync(path.join(directory, '.oxfmtrc.json'))) {
    if (directory === root || directory === path.dirname(directory)) {
      throw new Error(`No formatter config for ${file}`)
    }
    directory = path.dirname(directory)
  }
  const files = groups.get(directory) ?? []
  files.push(path.relative(directory, absolute))
  groups.set(directory, files)
}

let failed = false
for (const [directory, files] of groups) {
  try {
    execFileSync(
      'pnpm',
      ['exec', 'oxfmt', '--check', '--no-error-on-unmatched-pattern', ...files],
      { cwd: directory, stdio: 'inherit' }
    )
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error) || error.status === null) {
      throw error
    }
    failed = true
  }
}
if (failed) {
  process.exitCode = 1
}
