import { expect, test } from 'vitest'

import { asErrorWithResponse } from '../../src/utils/error-utils.js'

test('asErrorWithResponse reads an Octokit top-level status', () => {
  const error = Object.assign(new Error('Not Found'), { status: 404 })

  expect(asErrorWithResponse(error).status).toBe(404)
})

test('asErrorWithResponse falls back to a response status', () => {
  const error = Object.assign(new Error('Validation Failed'), {
    response: {
      status: 422,
      headers: {},
      data: { message: 'Validation Failed' }
    }
  })

  expect(asErrorWithResponse(error).status).toBe(422)
})
