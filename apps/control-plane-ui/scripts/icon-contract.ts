import ts from 'typescript'

export type IconContractIssue = Readonly<{
  file: string
  line: number
  message: string
}>

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function usesIconScale(attribute: ts.JsxAttribute): boolean {
  const initializer = attribute.initializer
  if (!initializer || !ts.isJsxExpression(initializer)) return false
  const expression = initializer.expression
  return (
    expression !== undefined &&
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'ICON_SIZE'
  )
}

export function validateIconContract(
  files: Readonly<Record<string, string>>
): IconContractIssue[] {
  const issues: IconContractIssue[] = []

  for (const [file, sourceText] of Object.entries(files)) {
    // Use the TypeScript parser so multiline imports and JSX are handled as code,
    // not as text that happens to look like code.
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const sourceModule = node.moduleSpecifier.text
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text
            if (
              /^Icon[A-Z]/.test(importedName) &&
              sourceModule !== '@tabler/icons-react'
            ) {
              issues.push({
                file,
                line: lineOf(source, element),
                message: `${importedName} must come from @tabler/icons-react`
              })
            }
          }
        }
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(source)
        if (/^Icon(?:[A-Z]|$)/.test(tagName)) {
          const size = node.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(source) === 'size'
          )
          if (!size || !usesIconScale(size)) {
            issues.push({
              file,
              line: lineOf(source, node),
              message: `${tagName} size must use ICON_SIZE`
            })
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return issues.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line
  )
}
