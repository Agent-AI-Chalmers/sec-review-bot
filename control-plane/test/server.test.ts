import test from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'

const { decodeRunId } = await import('../src/server.js')

test('decodeRunId decodes a valid encoded identifier', () => {
  assert.equal(decodeRunId('run%2Fwith%20spaces'), 'run/with spaces')
})

test('decodeRunId rejects malformed percent-encoding as a path input error', () => {
  assert.throws(
    () => decodeRunId('%'),
    (error: unknown) => {
      assert.equal((error as { statusCode?: unknown }).statusCode, 400)
      assert.equal((error as { code?: unknown }).code, 'INVALID_PATH_PARAMETER')
      return true
    }
  )
})
