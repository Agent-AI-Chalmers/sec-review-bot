import assert from 'node:assert/strict'
import test from 'node:test'

import { findStyleLiterals } from '../scripts/style-literals.js'

test('style literal reporting classifies only nonzero px and rem values', () => {
  const findings = findStyleLiterals({
    'example.css': `
      .example {
        padding: 12px var(--space-2);
        margin: 0;
        border-radius: 0.5rem;
        font-size: var(--font-size-sm);
        gap: 1em;
      }
    `
  })

  assert.deepEqual(findings, [
    {
      kind: 'radius',
      file: 'example.css',
      line: 5,
      property: 'border-radius',
      value: '0.5rem'
    },
    {
      kind: 'spacing',
      file: 'example.css',
      line: 3,
      property: 'padding',
      value: '12px var(--space-2)'
    }
  ])
})
