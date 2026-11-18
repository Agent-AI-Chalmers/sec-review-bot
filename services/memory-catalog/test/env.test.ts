import { expect, test, vi } from 'vitest'

import { integerEnv } from '../src/env.js'

test('integerEnv defaults only when the variable is unset', ({ onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  vi.stubEnv('TEST_INTEGER_ENV', undefined)
  expect(integerEnv('TEST_INTEGER_ENV', 7)).toBe(7)
})

test.for([
  { name: 'lower boundary', value: '0', minimum: 0, maximum: 12, expected: 0 },
  {
    name: 'upper boundary',
    value: '12',
    minimum: 0,
    maximum: 12,
    expected: 12
  }
])('integerEnv accepts $name', ({ value, minimum, maximum, expected }, { onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  vi.stubEnv('TEST_INTEGER_ENV', value)
  expect(integerEnv('TEST_INTEGER_ENV', 7, minimum, maximum)).toBe(expected)
})

test.for(['', '10ms', '1.5', '9007199254740992', '0'])(
  'integerEnv rejects invalid value %j',
  (value, { onTestFinished }) => {
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    vi.stubEnv('TEST_INTEGER_ENV', value)
    expect(() => integerEnv('TEST_INTEGER_ENV', 7)).toThrow(/TEST_INTEGER_ENV/)
  }
)

test('integerEnv rejects values above an explicit maximum', ({ onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  vi.stubEnv('TEST_INTEGER_ENV', '13')
  expect(() => integerEnv('TEST_INTEGER_ENV', 7, 1, 12)).toThrow(
    /TEST_INTEGER_ENV must be at most 12/
  )
})
