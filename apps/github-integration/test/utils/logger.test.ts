import assert from 'node:assert/strict'
import test from 'node:test'

import { logError } from '../../src/utils/logger.js'

function captureError(fields: Record<string, unknown>): string {
  const lines: string[] = []
  const restore = console.error
  console.error = (line: unknown) => lines.push(String(line))
  try {
    logError('event', fields)
  } finally {
    console.error = restore
  }
  return lines[0] ?? ''
}

test('an error field is logged with its message, not as an empty object', () => {
  // `JSON.stringify` drops an Error's own non-enumerable `message` and `stack`, so an error
  // passed as a field used to render as `error={}`: the line said something failed and nothing
  // about what.
  const line = captureError({ error: new Error('GitHub answered 502') })
  assert.match(line, /GitHub answered 502/)
  assert.doesNotMatch(line, /error=\{\}/)
})

test('an error field keeps its name, code, status, and cause', () => {
  const cause = new Error('socket hang up')
  const error = Object.assign(new TypeError('fetch failed', { cause }), {
    code: 'ECONNRESET',
    status: 502
  })
  const line = captureError({ error })
  for (const part of [
    'TypeError',
    'fetch failed',
    'ECONNRESET',
    '502',
    'socket hang up'
  ])
    assert.ok(line.includes(part), `${part} is missing from ${line}`)
})

test('a plain object field is still logged as JSON', () => {
  assert.match(captureError({ detail: { a: 1 } }), /detail=\{"a":1\}/)
})
