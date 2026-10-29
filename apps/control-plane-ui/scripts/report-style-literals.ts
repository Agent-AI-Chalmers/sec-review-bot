import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { findStyleLiterals, type StyleLiteralKind } from './style-literals.js'

const packageRoot = path.resolve(import.meta.dirname, '..')
const stylesDirectory = path.join(packageRoot, 'browser/styles')
const files = (await readdir(stylesDirectory))
  .filter((file) => file.endsWith('.css'))
  .sort()
const stylesheets = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      `browser/styles/${file}`,
      await readFile(path.join(stylesDirectory, file), 'utf8')
    ])
  )
)
const findings = findStyleLiterals(stylesheets)
const kinds: readonly StyleLiteralKind[] = ['spacing', 'radius', 'font-size']

for (const kind of kinds) {
  const matches = findings.filter((finding) => finding.kind === kind)
  console.log(`\n${kind}: ${matches.length}`)
  for (const finding of matches) {
    console.log(
      `  ${finding.file}:${finding.line} ${finding.property}: ${finding.value}`
    )
  }
}

console.log(
  `\nStyle literal report completed with ${findings.length} finding(s).`
)
