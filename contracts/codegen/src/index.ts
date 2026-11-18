import { memoryStorage } from '@kubb/core'
import { pluginTs, resolverTs } from '@kubb/plugin-ts'
import { createKubb } from 'kubb'
import { parseSync, type TSTypeAliasDeclaration } from 'oxc-parser'

export { formatGenerated } from './format-generated.js'

const BODY_SUFFIX = 'ResponseBody'
const MAP_SUFFIX = 'ResponseBodyByStatus'

function normalizeResponseTypes(source: string): string {
  const { program, comments, errors } = parseSync('types.ts', source)
  if (errors.length) {
    throw new Error(`Invalid generated TypeScript: ${JSON.stringify(errors)}`)
  }
  const declarations = program.body.map((node) =>
    node.type === 'ExportNamedDeclaration' ? node.declaration : node
  )
  const aliases = new Map(
    declarations
      .filter((node): node is TSTypeAliasDeclaration => node?.type === 'TSTypeAliasDeclaration')
      .map((node) => [node.id.name, node])
  )
  const statementOf = (alias: TSTypeAliasDeclaration) =>
    program.body.find(
      (node) => node.type === 'ExportNamedDeclaration' && node.declaration === alias
    ) ?? alias
  const leadingComments = (alias: TSTypeAliasDeclaration) => {
    const statement = statementOf(alias)
    const previous = program.body.filter((node) => node.end <= statement.start).at(-1)?.end ?? 0
    return comments.filter((comment) => comment.start >= previous && comment.end <= statement.start)
  }
  const edits: { start: number; end: number; text: string }[] = []
  const removed = new Set<TSTypeAliasDeclaration>()
  for (const [name, mapping] of aliases) {
    if (!name.endsWith(MAP_SUFFIX)) {
      continue
    }
    if (mapping.typeAnnotation.type !== 'TSTypeLiteral') {
      throw new Error(`Expected a response status map: ${name}`)
    }
    const bodyName = name.slice(0, -MAP_SUFFIX.length) + BODY_SUFFIX
    const body = aliases.get(bodyName)
    if (body === undefined) {
      throw new Error(`Missing ${bodyName}; check for an OpenAPI schema name collision`)
    }
    const members =
      body.typeAnnotation.type === 'TSUnionType' ? body.typeAnnotation.types : [body.typeAnnotation]
    const selected = members.map((member) => {
      if (member.type !== 'TSTypeReference' || member.typeName.type !== 'Identifier') {
        throw new Error(`Unexpected response body member in ${bodyName}`)
      }
      return member.typeName.name
    })
    const statusByAlias = new Map<string, string>()
    for (const property of mapping.typeAnnotation.members) {
      if (
        property.type !== 'TSPropertySignature' ||
        property.key.type !== 'Literal' ||
        typeof property.key.value !== 'string' ||
        property.typeAnnotation === null ||
        property.typeAnnotation.typeAnnotation.type !== 'TSTypeReference' ||
        property.typeAnnotation.typeAnnotation.typeName.type !== 'Identifier'
      ) {
        throw new Error(`Unsupported response status entry in ${name}`)
      }
      const statusName = property.typeAnnotation.typeAnnotation.typeName.name
      const status = aliases.get(statusName)
      if (status === undefined) {
        throw new Error(`Missing response status type: ${statusName}`)
      }
      statusByAlias.set(statusName, property.key.value)
      // Put the body and its documentation at the status entry. Separate StatusNNN
      // aliases add another lookup without providing another contract boundary.
      const documentation = leadingComments(status)
        .map((comment) => source.slice(comment.start, comment.end))
        .join('\n')
      edits.push({
        start: property.start,
        end: property.end,
        text:
          (documentation ? documentation + '\n' : '') +
          source.slice(property.start, property.typeAnnotation.typeAnnotation.start) +
          source.slice(status.typeAnnotation.start, status.typeAnnotation.end) +
          source.slice(property.typeAnnotation.typeAnnotation.end, property.end)
      })
      removed.add(status)
    }
    // Keep Kubb's selection, including its error-only fallback; never substitute
    // all status keys, which would mix error bodies into successful results.
    const keys = selected.map((member) => {
      const key = statusByAlias.get(member)
      if (key === undefined) {
        throw new Error(`Response body ${bodyName} is absent from its status map`)
      }
      return JSON.stringify(key)
    })
    edits.push({
      start: body.typeAnnotation.start,
      end: body.typeAnnotation.end,
      text: `${name}[${keys.join(' | ')}]`
    })
    for (const comment of leadingComments(body)) {
      edits.push({
        start: comment.start,
        end: comment.end,
        text: '/** Response body selected by Kubb: success statuses when present, otherwise declared response bodies. */'
      })
    }
  }
  for (const alias of removed) {
    edits.push({
      start: leadingComments(alias)[0]?.start ?? statementOf(alias).start,
      end: alias.end,
      text: ''
    })
  }
  // Apply edits backwards, preserving unrelated declarations and Kubb's spacing.
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  }
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
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (errors.length) {
      throw new Error(`Kubb generation failed: ${JSON.stringify(errors)}`)
    }
    const outputPath = result.files[0]?.path
    if (outputPath === undefined || result.files.length !== 1) {
      throw new Error(`Kubb generated ${result.files.length} files; expected one`)
    }
    const rendered = await result.storage.readItem(outputPath)
    if (typeof rendered !== 'string') {
      throw new Error(`Kubb did not generate text at ${outputPath}`)
    }
    return normalizeResponseTypes(rendered)
  } finally {
    kubb.dispose()
  }
}
