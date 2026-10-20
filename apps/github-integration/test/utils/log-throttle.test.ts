// Verifies the in-memory log throttle bounds both per-key frequency and total remembered keys.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createLogThrottle } from '../../src/utils/log-throttle.js'

test('a key logs once per window and again after it elapses', () => {
  let clock = 1_000
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 10,
    now: () => clock
  })
  assert.equal(allow('repo'), true, 'first sighting logs')
  assert.equal(allow('repo'), false, 'within the window is suppressed')
  clock -= 50
  assert.equal(
    allow('repo'),
    false,
    'a backwards clock must not reopen the gate'
  )
  clock = 1_099
  assert.equal(allow('repo'), false, 'still inside the window')
  clock = 1_100
  assert.equal(allow('repo'), true, 'a full window reopens the gate')
})

test('different keys are throttled independently', () => {
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 10,
    now: () => 0
  })
  assert.equal(allow('a'), true)
  assert.equal(allow('b'), true)
  assert.equal(allow('a'), false)
  assert.equal(allow('b'), false)
})

test('the number of distinct keys is capped, so invented keys cannot grow the table', () => {
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 2,
    now: () => 0
  })
  assert.equal(allow('a'), true)
  assert.equal(allow('b'), true)
  assert.equal(allow('c'), false, 'a key beyond the cap is refused')
  assert.equal(
    allow('a'),
    false,
    'existing keys are still governed by the interval'
  )
})

test('an elapsed interval frees a key but not the cap', () => {
  let clock = 0
  const allow = createLogThrottle({
    minIntervalMs: 100,
    maxKeys: 1,
    now: () => clock
  })
  assert.equal(allow('a'), true)
  clock = 100
  assert.equal(allow('a'), true, 'the remembered key can log again')
  assert.equal(allow('b'), false, 'the cap still refuses a new key')
})

test('invalid configuration is rejected up front', () => {
  assert.throws(
    () => createLogThrottle({ minIntervalMs: -1, maxKeys: 1 }),
    /minIntervalMs/
  )
  assert.throws(
    () => createLogThrottle({ minIntervalMs: 0, maxKeys: 0 }),
    /maxKeys/
  )
})
