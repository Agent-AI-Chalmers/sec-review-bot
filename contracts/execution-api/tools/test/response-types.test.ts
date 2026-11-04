import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { renderOpenApiTypes } from '@sec-review-bot/contract-codegen'

test('every emitted operation response alias indexes its status map', async () => {
  const specPath = path.resolve(import.meta.dirname, '../../v1/openapi.yaml')
  const generated = await renderOpenApiTypes(specPath)
  const file = ts.createSourceFile(
    'types.ts',
    generated,
    ts.ScriptTarget.Latest,
    true
  )
  const aliases = new Map(
    file.statements
      .filter(ts.isTypeAliasDeclaration)
      .map((node) => [node.name.text, node])
  )
  let checked = 0
  for (const [name, alias] of aliases) {
    if (!name.endsWith('ResponseBody') || !aliases.has(`${name}ByStatus`))
      continue
    assert.ok(
      ts.isIndexedAccessTypeNode(alias.type),
      `${name} must index its status map`
    )
    assert.ok(ts.isTypeReferenceNode(alias.type.objectType))
    assert.equal(
      alias.type.objectType.typeName.getText(file),
      `${name}ByStatus`
    )
    checked++
  }
  assert.ok(checked > 0)
})
