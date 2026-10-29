import Color from 'colorjs.io'
import postcss from 'postcss'

export type ThemeName = 'light' | 'dark'

export type ThemeColors = Readonly<
  Record<ThemeName, Readonly<Record<string, string>>>
>

export type ColorContractIssue = Readonly<{
  severity: 'error' | 'warning'
  message: string
}>

type ContrastRequirement = Readonly<{
  foreground: string
  background: string
  minimum: number
}>

const THEME_SELECTORS: Readonly<Record<ThemeName, string>> = {
  light: ':root',
  dark: "[data-theme='dark']"
}

// Muted and link colors carry prose, so they use the WCAG normal-text threshold.
// Accent and status colors identify controls or state marks rather than body text,
// so their contract is the 3:1 non-text/UI-component threshold.
const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  { foreground: '--muted', background: '--surface-raised', minimum: 4.5 },
  {
    foreground: '--failure-text',
    background: '--surface-raised',
    minimum: 4.5
  },
  { foreground: '--link', background: '--surface-raised', minimum: 4.5 },
  { foreground: '--brand', background: '--surface-raised', minimum: 3 },
  { foreground: '--status-active', background: '--surface-raised', minimum: 3 },
  {
    foreground: '--status-complete',
    background: '--surface-raised',
    minimum: 3
  },
  { foreground: '--status-failed', background: '--surface-raised', minimum: 3 }
]

export function parseThemeColors(css: string): ThemeColors {
  const root = postcss.parse(css)
  const colorProperties = new Set<string>()
  const themes: Record<ThemeName, Record<string, string>> = {
    light: {},
    dark: {}
  }

  // `@property` is the palette ownership boundary in base.css. Deriving the set
  // from typed `<color>` declarations keeps new tokens covered automatically and
  // excludes unrelated custom properties such as spacing and transition timing.
  root.walkAtRules('property', (rule) => {
    const syntax = rule.nodes?.find(
      (node) => node.type === 'decl' && node.prop === 'syntax'
    )
    if (
      syntax?.type === 'decl' &&
      syntax.value.replaceAll(/['"]/g, '') === '<color>'
    ) {
      colorProperties.add(rule.params)
    }
  })

  // Pre-populate both themes so a registered color remains required even when
  // its declarations are accidentally removed from both theme blocks.
  for (const property of colorProperties) {
    themes.light[property] = ''
    themes.dark[property] = ''
  }

  for (const [theme, selector] of Object.entries(THEME_SELECTORS) as [
    ThemeName,
    string
  ][]) {
    const rule = root.nodes.find(
      (node) => node.type === 'rule' && node.selector === selector
    )
    if (rule?.type !== 'rule') {
      throw new Error(`Missing ${selector} color theme rule`)
    }

    rule.walkDecls(/^--/, (declaration) => {
      if (colorProperties.has(declaration.prop)) {
        themes[theme][declaration.prop] = declaration.value
      }
    })
  }

  return themes
}

export function validateThemeTransitionCoverage(
  css: string
): ColorContractIssue[] {
  const root = postcss.parse(css)
  const registeredColors = new Set<string>()
  root.walkAtRules('property', (rule) => {
    const syntax = rule.nodes?.find(
      (node) => node.type === 'decl' && node.prop === 'syntax'
    )
    if (
      syntax?.type === 'decl' &&
      syntax.value.replaceAll(/['"]/g, '') === '<color>'
    ) {
      registeredColors.add(rule.params)
    }
  })

  const transitionRule = root.nodes.find(
    (node) => node.type === 'rule' && node.selector === '.theme-transition'
  )
  const transition =
    transitionRule?.type === 'rule'
      ? transitionRule.nodes.find(
          (node) => node.type === 'decl' && node.prop === 'transition'
        )
      : undefined
  const transitionedColors = new Set(
    transition?.type === 'decl'
      ? [...transition.value.matchAll(/--[a-z0-9-]+/gi)].map(([name]) => name)
      : []
  )

  return [...registeredColors]
    .filter((name) => !transitionedColors.has(name))
    .map((name) => ({
      severity: 'error' as const,
      message: `.theme-transition does not animate ${name}`
    }))
}

export function validateColorContract(
  themes: ThemeColors,
  brandColors: readonly string[]
): ColorContractIssue[] {
  const issues: ColorContractIssue[] = []
  const colorNames = new Set([
    ...Object.keys(themes.light),
    ...Object.keys(themes.dark)
  ])

  for (const name of colorNames) {
    for (const theme of Object.keys(THEME_SELECTORS) as ThemeName[]) {
      const value = themes[theme][name]
      if (!value) {
        issues.push({ severity: 'error', message: `${theme}: missing ${name}` })
        continue
      }
      try {
        new Color(value)
      } catch (error) {
        issues.push({
          severity: 'error',
          message: `${theme}: invalid ${name} color ${JSON.stringify(value)}: ${String(error)}`
        })
      }
    }
  }

  for (const [theme, colors] of Object.entries(themes) as [
    ThemeName,
    Readonly<Record<string, string>>
  ][]) {
    for (const requirement of CONTRAST_REQUIREMENTS) {
      const foreground = colors[requirement.foreground]
      const background = colors[requirement.background]
      if (!foreground || !background) {
        issues.push({
          severity: 'error',
          message: `${theme}: missing ${!foreground ? requirement.foreground : requirement.background}`
        })
        continue
      }

      try {
        const ratio = new Color(foreground).contrastWCAG21(background)
        if (ratio < requirement.minimum) {
          issues.push({
            severity: 'error',
            message:
              `${theme}: ${requirement.foreground} on ${requirement.background} ` +
              `has ${ratio.toFixed(2)}:1 contrast; requires ${requirement.minimum.toFixed(1)}:1`
          })
        }
      } catch (error) {
        issues.push({
          severity: 'error',
          message: `${theme}: invalid color in ${requirement.foreground}/${requirement.background}: ${String(error)}`
        })
      }
    }
  }

  const parsedBrandColors = brandColors.map((value, index) => {
    try {
      return new Color(value)
    } catch (error) {
      issues.push({
        severity: 'error',
        message: `brand.${index}: invalid color ${JSON.stringify(value)}: ${String(error)}`
      })
      return null
    }
  })

  for (let index = 1; index < parsedBrandColors.length; index += 1) {
    const previous = parsedBrandColors[index - 1]
    const current = parsedBrandColors[index]
    if (!previous || !current) continue

    const previousLightness = previous.to('oklch').coords[0]
    const currentLightness = current.to('oklch').coords[0]
    if (previousLightness === null || currentLightness === null) {
      issues.push({
        severity: 'error',
        message: `brand.${index - 1}/brand.${index} has no OKLCH lightness`
      })
      continue
    }
    if (currentLightness >= previousLightness) {
      issues.push({
        severity: 'error',
        message: `brand.${index} must be darker than brand.${index - 1}`
      })
    }

    const difference = previous.deltaE2000(current)
    // A small perceptual gap can be intentional within a scale. Report it for
    // design review, but do not make an aesthetic heuristic a merge blocker.
    if (difference < 2) {
      issues.push({
        severity: 'warning',
        message: `brand.${index - 1} and brand.${index} are only ΔE2000 ${difference.toFixed(2)} apart`
      })
    }
  }

  return issues
}
