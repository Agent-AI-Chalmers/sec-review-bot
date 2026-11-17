// Verifies the in-memory log throttle bounds both per-key frequency and total remembered keys.
import { expect, test } from 'vitest'

import { createLogThrottle } from '../../src/utils/log-throttle.js'

test('a key logs once per window and again after it elapses', () => {
  let clock = 1_000
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 10,
    now: () => clock
  })
  expect(allow('repo'), 'first sighting logs').toBe(true)
  expect(allow('repo'), 'within the window is suppressed').toBe(false)
  clock -= 50
  expect(allow('repo'), 'a backwards clock must not reopen the gate').toBe(
    false
  )
  clock = 1_099
  expect(allow('repo'), 'still inside the window').toBe(false)
  clock = 1_100
  expect(allow('repo'), 'a full window reopens the gate').toBe(true)
})

test('different keys are throttled independently', () => {
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 10,
    now: () => 0
  })
  expect(allow('a')).toBe(true)
  expect(allow('b')).toBe(true)
  expect(allow('a')).toBe(false)
  expect(allow('b')).toBe(false)
})

test('the number of distinct keys is capped, so invented keys cannot grow the table', () => {
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 2,
    now: () => 0
  })
  expect(allow('a')).toBe(true)
  expect(allow('b')).toBe(true)
  expect(allow('c'), 'a key beyond the cap is refused').toBe(false)
  expect(allow('a'), 'existing keys are still governed by the interval').toBe(
    false
  )
})

test('an elapsed interval frees a key but not the cap', () => {
  let clock = 0
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 1,
    now: () => clock
  })
  expect(allow('a')).toBe(true)
  clock = 100
  expect(allow('a'), 'the remembered key can log again').toBe(true)
  expect(allow('b'), 'the cap still refuses a new key').toBe(false)
})

test('invalid configuration is rejected up front', () => {
  expect(() => createLogThrottle({ minIntervalMs: -1, maxKeys: 1 })).toThrow(
    /minIntervalMs/
  )
  expect(() => createLogThrottle({ minIntervalMs: 0, maxKeys: 0 })).toThrow(
    /maxKeys/
  )
})
