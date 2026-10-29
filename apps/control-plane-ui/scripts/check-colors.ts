import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { BRAND_COLORS } from '../browser/app/colors.js'
import {
  parseThemeColors,
  validateColorContract,
  validateThemeTransitionCoverage
} from './color-contract.js'

const stylesheetPath = path.resolve(
  import.meta.dirname,
  '../browser/styles/base.css'
)
const stylesheet = await readFile(stylesheetPath, 'utf8')
const issues = [
  ...validateColorContract(parseThemeColors(stylesheet), BRAND_COLORS),
  ...validateThemeTransitionCoverage(stylesheet)
]

for (const issue of issues) {
  const output = issue.severity === 'error' ? console.error : console.warn
  output(`${issue.severity}: ${issue.message}`)
}

const errorCount = issues.filter((issue) => issue.severity === 'error').length
if (errorCount > 0) {
  console.error(`Color contract failed with ${errorCount} error(s).`)
  process.exitCode = 1
} else {
  console.log('Color contract passed.')
}
