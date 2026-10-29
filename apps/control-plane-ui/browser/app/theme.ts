import {
  Badge,
  Button,
  Card,
  createTheme,
  Paper,
  Table,
  Timeline
} from '@mantine/core'

import { BRAND_COLORS } from './colors.js'

/**
 * Console-wide design tokens.
 *
 * The console is a dense operational surface, so the theme's job is to give the
 * few things an operator scans for — status, identity, failure — enough weight to
 * be found at a glance, and to leave everything else quiet.
 */
// Inter covers Latin; the CJK faces are listed after it so a Chinese glyph is drawn by a font
// designed for it instead of by whatever `system-ui` happens to resolve to. Without them the two
// scripts in one label ("Execution" beside "准备") come from different families and their stroke
// weight and x-height visibly disagree. `PingFang SC` is the macOS default CJK UI face, `Noto Sans
// CJK SC` the Linux one, and `Microsoft YaHei` the Windows one; each is optional, so the stack
// degrades to `system-ui` on a machine that has none of them.
export const FONT_STACK =
  '"Inter Variable", Inter, "Inter var", ui-sans-serif, system-ui, -apple-system, ' +
  '"Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", ' +
  '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif'

// Named Latin monospace faces come before any CJK one. `ui-monospace` alone resolves to whatever
// the platform considers monospaced, and on a machine without a Latin monospace installed that is
// a CJK mono face (Noto Sans Mono CJK here). Its Latin glyphs are heavy and tightly spaced, so
// every run id rendered noticeably worse than the same id in a Latin mono. Listing the Latin faces
// explicitly keeps ids looking the same everywhere; the CJK faces follow so a label mixing an id
// with Chinese still finds a monospaced CJK glyph instead of falling back to a proportional one.
export const MONO_STACK =
  '"JetBrains Mono", "SFMono-Regular", "SF Mono", Menlo, Consolas, ' +
  '"DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono", ui-monospace, ' +
  '"Noto Sans Mono CJK SC", monospace'

/** Amber accent, deliberately outside the blue-violet range that AI-generated UIs
 * default to, and far enough in hue from the green/red status colours that the two
 * never read as related. Mantine requires a fixed ten-shade tuple, darkest last. */
export const mantineTheme = createTheme({
  primaryColor: 'brand',
  colors: { brand: [...BRAND_COLORS] },
  fontFamily: FONT_STACK,
  fontFamilyMonospace: MONO_STACK,
  headings: {
    fontFamily: FONT_STACK,
    fontWeight: '700',
    // The console is dense, so the type scale only opens up where it carries
    // hierarchy: page title, section title, and a slightly raised subsection.
    sizes: {
      h1: { fontSize: '2rem', lineHeight: '1.2' },
      h2: { fontSize: '1.25rem', lineHeight: '1.3' },
      h3: { fontSize: '1.0625rem', lineHeight: '1.35' }
    }
  },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    Paper: Paper.extend({
      defaultProps: { radius: 'md', shadow: 'sm' }
    }),
    Card: Card.extend({
      defaultProps: { radius: 'md', shadow: 'sm', withBorder: true }
    }),
    Badge: Badge.extend({
      defaultProps: { radius: 'xl', variant: 'light' }
    }),
    Button: Button.extend({
      defaultProps: { radius: 'md' }
    }),
    Table: Table.extend({
      defaultProps: { verticalSpacing: 'sm', horizontalSpacing: 'md' }
    }),
    Timeline: Timeline.extend({
      defaultProps: { bulletSize: 26, lineWidth: 2 }
    })
  }
})
