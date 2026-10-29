import postcss from 'postcss'

export type StyleLiteralKind = 'spacing' | 'radius' | 'font-size'

export type StyleLiteral = Readonly<{
  kind: StyleLiteralKind
  file: string
  line: number
  property: string
  value: string
}>

const SPACING_PROPERTY =
  /^(?:margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|scroll-margin|scroll-padding)(?:-|$)/
// Zero is always reusable, and em/% values are often tied to local content. The
// first report stays narrow: nonzero px/rem values that may belong in a shared scale.
const NONZERO_LENGTH = /(?:^|[^\w.-])(?:\d*\.\d+|[1-9]\d*)(?:px|rem)\b/i

function literalKind(property: string): StyleLiteralKind | undefined {
  if (property === 'font-size') return 'font-size'
  if (property === 'border-radius') return 'radius'
  if (SPACING_PROPERTY.test(property)) return 'spacing'
  return undefined
}

export function findStyleLiterals(
  stylesheets: Readonly<Record<string, string>>
): StyleLiteral[] {
  const findings: StyleLiteral[] = []

  for (const [file, source] of Object.entries(stylesheets)) {
    const root = postcss.parse(source, { from: file })
    root.walkDecls((declaration) => {
      const kind = literalKind(declaration.prop)
      if (!kind || !NONZERO_LENGTH.test(declaration.value)) return

      findings.push({
        kind,
        file,
        line: declaration.source?.start?.line ?? 1,
        property: declaration.prop,
        value: declaration.value
      })
    })
  }

  return findings.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line
  )
}
