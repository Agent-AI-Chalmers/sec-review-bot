import assert from 'node:assert/strict'
import test from 'node:test'

import { integerEnv } from '../src/env.js'

await test('integerEnv defaults only when the variable is unset', () => {
  delete process.env.TEST_INTEGER_ENV
  assert.strictEqual(integerEnv('TEST_INTEGER_ENV', 7), 7)
})

await test('integerEnv accepts values at explicit range boundaries', (t) => {
  t.after(() => delete process.env.TEST_INTEGER_ENV)
  process.env.TEST_INTEGER_ENV = '0'
  assert.strictEqual(integerEnv('TEST_INTEGER_ENV', 7, 0, 12), 0)
  process.env.TEST_INTEGER_ENV = '12'
  assert.strictEqual(integerEnv('TEST_INTEGER_ENV', 7, 0, 12), 12)
})

await test('integerEnv rejects malformed, unsafe, and out-of-range values', (t) => {
  t.after(() => delete process.env.TEST_INTEGER_ENV)
  for (const value of ['', '10ms', '1.5', '9007199254740992', '0']) {
    process.env.TEST_INTEGER_ENV = value
    assert.throws(() => integerEnv('TEST_INTEGER_ENV', 7), /TEST_INTEGER_ENV/)
  }
})

await test('integerEnv rejects values above an explicit maximum', (t) => {
  t.after(() => delete process.env.TEST_INTEGER_ENV)
  process.env.TEST_INTEGER_ENV = '13'
  assert.throws(
    () => integerEnv('TEST_INTEGER_ENV', 7, 1, 12),
    /TEST_INTEGER_ENV must be at most 12/,
  )
})
