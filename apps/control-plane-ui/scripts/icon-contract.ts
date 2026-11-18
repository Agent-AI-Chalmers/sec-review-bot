import { parseSync, Visitor } from 'oxc-parser'

export type IconContractIssue = Readonly<{
  file: string
  line: number
  message: string
}>

export function validateIconContract(files: Readonly<Record<string, string>>): IconContractIssue[] {
  const issues: IconContractIssue[] = []

  for (const [file, sourceText] of Object.entries(files)) {
    const { program, errors } = parseSync(file, sourceText)
    if (errors.length) {
      throw new Error(`Invalid icon source ${file}: ${JSON.stringify(errors)}`)
    }
    const lineOf = (start: number) => sourceText.slice(0, start).split('\n').length
    new Visitor({
      ImportDeclaration(node) {
        for (const element of node.specifiers) {
          if (element.type !== 'ImportSpecifier') {
            continue
          }
          const importedName =
            element.imported.type === 'Identifier'
              ? element.imported.name
              : String(element.imported.value)
          if (/^Icon[A-Z]/.test(importedName) && node.source.value !== '@tabler/icons-react') {
            issues.push({
              file,
              line: lineOf(element.start),
              message: `${importedName} must come from @tabler/icons-react`
            })
          }
        }
      },
      JSXOpeningElement(node) {
        const tagName = sourceText.slice(node.name.start, node.name.end)
        if (!/^Icon(?:[A-Z]|$)/.test(tagName)) {
          return
        }
        const size = node.attributes.find(
          (attribute) =>
            attribute.type === 'JSXAttribute' &&
            attribute.name.type === 'JSXIdentifier' &&
            attribute.name.name === 'size'
        )
        const expression =
          size?.type === 'JSXAttribute' && size.value?.type === 'JSXExpressionContainer'
            ? size.value.expression
            : undefined
        if (
          expression?.type !== 'MemberExpression' ||
          expression.computed ||
          expression.object.type !== 'Identifier' ||
          expression.object.name !== 'ICON_SIZE'
        ) {
          issues.push({
            file,
            line: lineOf(node.start),
            message: `${tagName} size must use ICON_SIZE`
          })
        }
      }
    }).visit(program)
  }

  return issues.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}
