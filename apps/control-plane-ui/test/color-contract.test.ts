import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseThemeColors,
  validateColorContract,
  validateThemeTransitionCoverage
} from '../scripts/color-contract.js'

const validThemes = {
  light: {
    '--surface-raised': '#ffffff',
    '--muted': '#595959',
    '--link': '#765000',
    '--brand': '#8a5200',
    '--status-active': '#005fcc',
    '--status-complete': '#08783e',
    '--status-failed': '#c52222'
  },
  dark: {
    '--surface-raised': '#202020',
    '--muted': '#b5b5b5',
    '--link': '#e9aa35',
    '--brand': '#e9aa35',
    '--status-active': '#65a8ff',
    '--status-complete': '#54cf86',
    '--status-failed': '#ff7777'
  }
} as const

test('theme colors are read from the actual CSS rules', () => {
  const themes = parseThemeColors(`
    @property --surface-raised { syntax: '<color>'; initial-value: white; }
    @property --muted { syntax: '<color>'; initial-value: red; }
    :root { --surface-raised: white; --muted: #595959; --space: 4px; }
    [data-theme='dark'] { --surface-raised: #202020; --muted: #b5b5b5; }
  `)

  assert.deepEqual(themes, {
    light: {
      '--surface-raised': 'white',
      '--muted': '#595959'
    },
    dark: {
      '--surface-raised': '#202020',
      '--muted': '#b5b5b5'
    }
  })
})

test('insufficient semantic contrast blocks the color contract', () => {
  const issues = validateColorContract(
    {
      ...validThemes,
      light: { ...validThemes.light, '--muted': '#dddddd' }
    },
    ['#ffffff', '#777777', '#111111']
  )

  assert.ok(
    issues.some(
      (issue) =>
        issue.severity === 'error' && issue.message.includes('light: --muted')
    )
  )
})

test('a registered color missing from both themes blocks the contract', () => {
  const themes = parseThemeColors(`
    @property --orphan { syntax: '<color>'; initial-value: red; }
    :root {}
    [data-theme='dark'] {}
  `)

  const issues = validateColorContract(themes, [])

  assert.deepEqual(
    issues.filter((issue) => issue.message.includes('--orphan')),
    [
      { severity: 'error', message: 'light: missing --orphan' },
      { severity: 'error', message: 'dark: missing --orphan' }
    ]
  )
})

test('every registered color participates in the theme cross-fade', () => {
  const issues = validateThemeTransitionCoverage(`
    @property --surface { syntax: '<color>'; initial-value: white; }
    @property --link { syntax: '<color>'; initial-value: blue; }
    .theme-transition {
      transition: --surface var(--theme-transition) var(--theme-ease);
    }
  `)

  assert.deepEqual(issues, [
    {
      severity: 'error',
      message: '.theme-transition does not animate --link'
    }
  ])
})

test('brand shades must get darker while near-duplicates only warn', () => {
  const reversed = validateColorContract(validThemes, [
    '#ffffff',
    '#111111',
    '#777777'
  ])
  const duplicate = validateColorContract(validThemes, [
    '#ffffff',
    '#fefefe',
    '#111111'
  ])

  assert.ok(
    reversed.some(
      (issue) =>
        issue.severity === 'error' &&
        issue.message === 'brand.2 must be darker than brand.1'
    )
  )
  assert.ok(
    duplicate.some(
      (issue) =>
        issue.severity === 'warning' && issue.message.includes('ΔE2000')
    )
  )
})
