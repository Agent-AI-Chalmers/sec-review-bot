import path from 'node:path'
import { expect, test } from 'vitest'
import ts from 'typescript'
import { renderOpenApiTypes } from '@sec-review-bot/contract-codegen'

test('every emitted operation response alias indexes its status map', async () => {
  const specPath = path.resolve(import.meta.dirname, '../../v1/openapi.yaml')
  const generated = await renderOpenApiTypes(specPath)
  const file = ts.createSourceFile('types.ts', generated, ts.ScriptTarget.Latest, true)
  const aliases = new Map(
    file.statements.filter(ts.isTypeAliasDeclaration).map((node) => [node.name.text, node])
  )
  let checked = 0
  for (const [name, alias] of aliases) {
    if (!name.endsWith('ResponseBody') || !aliases.has(`${name}ByStatus`)) continue
    expect.assert(ts.isIndexedAccessTypeNode(alias.type), `${name} must index its status map`)
    expect.assert(ts.isTypeReferenceNode(alias.type.objectType))
    expect(alias.type.objectType.typeName.getText(file)).toBe(`${name}ByStatus`)
    checked++
  }
  expect.assert(checked > 0)
})
