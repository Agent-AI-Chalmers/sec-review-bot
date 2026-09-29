import assert from 'node:assert/strict'
import test from 'node:test'

import { asErrorWithResponse } from '../../utils/error-utils.js'

test('asErrorWithResponse reads an Octokit top-level status', () => {
  const error = Object.assign(new Error('Not Found'), { status: 404 })

  assert.equal(asErrorWithResponse(error).status, 404)
})

test('asErrorWithResponse falls back to a response status', () => {
  const error = Object.assign(new Error('Validation Failed'), {
    response: {
      status: 422,
      headers: {},
      data: { message: 'Validation Failed' }
    }
  })

  assert.equal(asErrorWithResponse(error).status, 422)
})
