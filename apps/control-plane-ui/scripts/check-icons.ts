import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { validateIconContract } from './icon-contract.js'

const packageRoot = path.resolve(import.meta.dirname, '..')
const browserDirectory = path.join(packageRoot, 'browser')
const files = (await readdir(browserDirectory, { recursive: true }))
  .filter((file) => file.endsWith('.tsx'))
  .sort()
const sources = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      `browser/${file}`,
      await readFile(path.join(browserDirectory, file), 'utf8')
    ])
  )
)
const issues = validateIconContract(sources)

for (const issue of issues) {
  console.error(`${issue.file}:${issue.line} ${issue.message}`)
}

if (issues.length > 0) {
  console.error(`Icon contract failed with ${issues.length} error(s).`)
  process.exitCode = 1
} else {
  console.log('Icon contract passed.')
}
