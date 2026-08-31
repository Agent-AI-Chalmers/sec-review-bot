import assert from 'node:assert/strict'
import test from 'node:test'

import { splitRepoFullName } from '../../infrastructure/github/repository-service.js'

test('splitRepoFullName accepts a valid owner and repository pair', () => {
  assert.deepEqual(splitRepoFullName('octo/example.repo'), {
    owner_login: 'octo',
    repo_name: 'example.repo'
  })
})

test('splitRepoFullName rejects ambiguous or malformed repository names', () => {
  for (const value of [
    '',
    'octo',
    'octo/example/extra',
    'octo /example',
    '-octo/example',
    'octo-/example',
    'octo/.'
  ]) {
    assert.throws(() => splitRepoFullName(value), /Invalid repository full name/)
  }
})
