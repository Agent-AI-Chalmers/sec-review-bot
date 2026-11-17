import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const browserDirectory = path.resolve(import.meta.dirname, '../browser')
const stylesDirectory = path.join(browserDirectory, 'styles')
const entryPath = path.join(browserDirectory, 'styles.css')
const expectedLoadOrder = [
  'base.css',
  'shell.css',
  'runs-detail.css',
  'parked-runs.css',
  'transitions.css',
  'memory.css',
  'workspace-editor.css',
  'trajectory-viewer.css',
  'responsive.css'
]
const responsiveFile = 'responsive.css'

function importedStyles(source: string): string[] {
  return [...source.matchAll(/@import\s+['"]\.\/styles\/([^'"]+)['"];?/g)].map(
    ([, file]) => file
  )
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 1
  let quote = ''

  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      expect(commentEnd, 'CSS comment must be closed').not.toBe(-1)
      index = commentEnd + 1
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) return index
  }

  throw new Error('CSS rule must have a closing brace')
}

function splitSelectors(prelude: string): string[] {
  const selectors: string[] = []
  let start = 0
  let parentheses = 0
  let brackets = 0
  let quote = ''

  for (let index = 0; index < prelude.length; index += 1) {
    const character = prelude[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === '[') brackets += 1
    else if (character === ']') brackets -= 1
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(prelude.slice(start, index).trim())
      start = index + 1
    }
  }

  selectors.push(prelude.slice(start).trim())
  return selectors
}

function classSelectors(source: string): string[] {
  const selectors: string[] = []
  const nestedRule = /^@(media|supports|container|layer)\b/
  let cursor = 0

  while (cursor < source.length) {
    const openingBrace = source.indexOf('{', cursor)
    if (openingBrace === -1) break
    const statementEnd = source.indexOf(';', cursor)
    if (statementEnd !== -1 && statementEnd < openingBrace) {
      cursor = statementEnd + 1
      continue
    }

    const prelude = source
      .slice(cursor, openingBrace)
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .trim()
    const closingBrace = matchingBrace(source, openingBrace)
    const body = source.slice(openingBrace + 1, closingBrace)

    if (nestedRule.test(prelude)) selectors.push(...classSelectors(body))
    else if (!prelude.startsWith('@')) {
      selectors.push(
        ...splitSelectors(prelude)
          .filter((selector) => selector.startsWith('.'))
          .map((selector) => selector.replace(/\s+/g, ' '))
      )
    }
    cursor = closingBrace + 1
  }

  return selectors
}

test('the stylesheet entry imports every domain file once without nested imports', async () => {
  const entry = await readFile(entryPath, 'utf8')
  const imports = importedStyles(entry)
  const files = (await readdir(stylesDirectory))
    .filter((file) => file.endsWith('.css'))
    .sort()

  expect(imports).toStrictEqual(expectedLoadOrder)
  expect([...imports].sort()).toStrictEqual(files)
  expect(new Set(imports).size).toBe(imports.length)

  for (const file of files) {
    const source = await readFile(path.join(stylesDirectory, file), 'utf8')
    expect(
      /@import\b/.test(source),
      `${file} must not create a second stylesheet entry graph`
    ).toBe(false)
  }
})

test('domain styles do not redefine the same selector in different files', async () => {
  const owners = new Map<string, string>()
  const files = (await readdir(stylesDirectory)).filter(
    (file) => file.endsWith('.css') && file !== responsiveFile
  )

  for (const file of files) {
    const source = await readFile(path.join(stylesDirectory, file), 'utf8')
    for (const selector of new Set(classSelectors(source))) {
      const existingOwner = owners.get(selector)
      expect(
        existingOwner,
        `${selector} is defined in both ${existingOwner} and ${file}`
      ).toBe(undefined)
      owners.set(selector, file)
    }
  }
})

test('responsive rules are isolated in the final stylesheet', async () => {
  const files = (await readdir(stylesDirectory)).filter((file) =>
    file.endsWith('.css')
  )

  for (const file of files) {
    const source = await readFile(path.join(stylesDirectory, file), 'utf8')
    if (file === responsiveFile) {
      expect(source).toMatch(/@media\b/)
    } else {
      expect(source, `${file} must not own media queries`).not.toMatch(
        /@media\b/
      )
    }
  }
})
