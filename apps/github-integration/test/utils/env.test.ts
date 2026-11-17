import { expect, test } from 'vitest'

import { integerEnv } from '../../src/utils/env.js'

test('integerEnv defaults only when the variable is unset', () => {
  delete process.env.TEST_INTEGER_ENV
  expect(integerEnv('TEST_INTEGER_ENV', 7)).toBe(7)
})

test('integerEnv accepts complete decimal integers within range', (t) => {
  t.onTestFinished(() => {
    delete process.env.TEST_INTEGER_ENV
  })
  process.env.TEST_INTEGER_ENV = ' 12 '
  expect(integerEnv('TEST_INTEGER_ENV', 7)).toBe(12)
  process.env.TEST_INTEGER_ENV = '0'
  expect(integerEnv('TEST_INTEGER_ENV', 7, 0)).toBe(0)
  process.env.TEST_INTEGER_ENV = '12'
  expect(integerEnv('TEST_INTEGER_ENV', 7, 1, 12)).toBe(12)
})

test('integerEnv rejects values above an explicit maximum', (t) => {
  t.onTestFinished(() => {
    delete process.env.TEST_INTEGER_ENV
  })
  process.env.TEST_INTEGER_ENV = '13'
  expect(() => integerEnv('TEST_INTEGER_ENV', 7, 1, 12)).toThrow(
    /TEST_INTEGER_ENV must be at most 12/
  )
})

test('integerEnv rejects malformed, unsafe, and out-of-range values', (t) => {
  t.onTestFinished(() => {
    delete process.env.TEST_INTEGER_ENV
  })
  for (const value of ['', '10ms', '1.5', '9007199254740992', '0']) {
    process.env.TEST_INTEGER_ENV = value
    expect(() => integerEnv('TEST_INTEGER_ENV', 7)).toThrow(/TEST_INTEGER_ENV/)
  }
})
