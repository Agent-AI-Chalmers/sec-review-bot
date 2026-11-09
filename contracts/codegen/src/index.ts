import { memoryStorage } from '@kubb/core'
import { pluginTs, resolverTs } from '@kubb/plugin-ts'
import { createKubb } from 'kubb'
import ts from 'typescript'

const BODY_SUFFIX = 'ResponseBody'
const MAP_SUFFIX = 'ResponseBodyByStatus'

function normalizeResponseTypes(source: string): string {
  const file = ts.createSourceFile(
    'types.ts',
    source,
    ts.ScriptTarget.Latest,
    true
  )
  const aliases = new Map(
    file.statements
      .filter(ts.isTypeAliasDeclaration)
      .map((node) => [node.name.text, node])
  )
  const edits: { start: number; end: number; text: string }[] = []
  const removed = new Set<ts.TypeAliasDeclaration>()
  for (const [name, mapping] of aliases) {
    if (!name.endsWith(MAP_SUFFIX)) continue
    if (!ts.isTypeLiteralNode(mapping.type))
      throw new Error(`Expected a response status map: ${name}`)
    const bodyName = name.slice(0, -MAP_SUFFIX.length) + BODY_SUFFIX
    const body = aliases.get(bodyName)
    if (body === undefined)
      throw new Error(
        `Missing ${bodyName}; check for an OpenAPI schema name collision`
      )
    const members = ts.isUnionTypeNode(body.type)
      ? body.type.types
      : [body.type]
    const selected = members.map((member) => {
      if (!ts.isTypeReferenceNode(member) || !ts.isIdentifier(member.typeName))
        throw new Error(`Unexpected response body member in ${bodyName}`)
      return member.typeName.text
    })
    const statusByAlias = new Map<string, string>()
    for (const property of mapping.type.members) {
      if (
        !ts.isPropertySignature(property) ||
        !ts.isStringLiteral(property.name) ||
        property.type === undefined ||
        !ts.isTypeReferenceNode(property.type) ||
        !ts.isIdentifier(property.type.typeName)
      ) {
        throw new Error(`Unsupported response status entry in ${name}`)
      }
      const statusName = property.type.typeName.text
      const status = aliases.get(statusName)
      if (status === undefined)
        throw new Error(`Missing response status type: ${statusName}`)
      statusByAlias.set(statusName, property.name.text)
      // Put the body and its documentation at the status entry. Separate StatusNNN
      // aliases add another lookup without providing another contract boundary.
      const comments = (
        ts.getLeadingCommentRanges(source, status.getFullStart()) ?? []
      )
        .map((comment) => source.slice(comment.pos, comment.end))
        .join('\n')
      edits.push({
        start: property.getStart(file),
        end: property.end,
        text:
          (comments ? comments + '\n' : '') +
          source.slice(property.getStart(file), property.type.getStart(file)) +
          source.slice(status.type.getStart(file), status.type.end) +
          source.slice(property.type.end, property.end)
      })
      removed.add(status)
    }
    // Keep Kubb's selection, including its error-only fallback; never substitute
    // all status keys, which would mix error bodies into successful results.
    const keys = selected.map((member) => {
      const key = statusByAlias.get(member)
      if (key === undefined)
        throw new Error(
          `Response body ${bodyName} is absent from its status map`
        )
      return JSON.stringify(key)
    })
    edits.push({
      start: body.type.getStart(file),
      end: body.type.end,
      text: `${name}[${keys.join(' | ')}]`
    })
    const comments =
      ts.getLeadingCommentRanges(source, body.getFullStart()) ?? []
    for (const comment of comments)
      edits.push({
        start: comment.pos,
        end: comment.end,
        text: '/** Response body selected by Kubb: success statuses when present, otherwise declared response bodies. */'
      })
  }
  for (const alias of removed)
    edits.push({ start: alias.getFullStart(), end: alias.end, text: '' })
  // Apply edits backwards, preserving unrelated declarations and Kubb's spacing.
  for (const edit of edits.sort((left, right) => right.start - left.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}

export async function renderOpenApiTypes(specPath: string): Promise<string> {
  const kubb = createKubb({
    input: specPath,
    output: { path: 'generated' },
    storage: memoryStorage(),
    plugins: [
      pluginTs({
        output: { path: 'types.ts', mode: 'file' },
        // Inline literals preserve discriminated unions; shared enum objects can widen them.
        enum: { type: 'inlineLiteral' },
        resolver: {
          response: {
            responses(node) {
              return resolverTs.name(`${node.operationId} ${MAP_SUFFIX}`)
            },
            response(node) {
              return resolverTs.name(`${node.operationId} ${BODY_SUFFIX}`)
            }
          }
        }
      })
    ]
  })
  try {
    const result = await kubb.safeBuild()
    const errors = result.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error'
    )
    if (errors.length)
      throw new Error(`Kubb generation failed: ${JSON.stringify(errors)}`)
    const outputPath = result.files[0]?.path
    if (outputPath === undefined || result.files.length !== 1)
      throw new Error(
        `Kubb generated ${result.files.length} files; expected one`
      )
    const rendered = await result.storage.readItem(outputPath)
    if (typeof rendered !== 'string')
      throw new Error(`Kubb did not generate text at ${outputPath}`)
    return normalizeResponseTypes(rendered)
  } finally {
    kubb.dispose()
  }
}
