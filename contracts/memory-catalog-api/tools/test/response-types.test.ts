import { SPEC_PATH } from '../src/paths.js'
import { expect, test } from 'vitest'
import { parseSync, type TSTypeAliasDeclaration } from 'oxc-parser'
import { renderOpenApiTypes } from '@sec-review-bot/contract-codegen'

test('every emitted operation response alias indexes its status map', async () => {
  const specPath = SPEC_PATH
  const generated = await renderOpenApiTypes(specPath)
  const { program, errors } = parseSync('types.ts', generated)
  expect(errors).toStrictEqual([])
  const aliases = new Map(
    program.body
      .map((node) => (node.type === 'ExportNamedDeclaration' ? node.declaration : node))
      .filter((node): node is TSTypeAliasDeclaration => node?.type === 'TSTypeAliasDeclaration')
      .map((node) => [node.id.name, node])
  )
  let checked = 0
  for (const [name, alias] of aliases) {
    if (!name.endsWith('ResponseBody') || !aliases.has(`${name}ByStatus`)) {
      continue
    }
    expect.assert(
      alias.typeAnnotation.type === 'TSIndexedAccessType',
      `${name} must index its status map`
    )
    expect.assert(alias.typeAnnotation.objectType.type === 'TSTypeReference')
    expect(
      generated.slice(
        alias.typeAnnotation.objectType.typeName.start,
        alias.typeAnnotation.objectType.typeName.end
      )
    ).toBe(`${name}ByStatus`)
    checked++
  }
  expect.assert(checked > 0)
})
