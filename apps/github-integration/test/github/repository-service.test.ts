import { expect, test } from 'vitest'

import { splitRepoFullName } from '../../src/github/repository-service.js'

test('splitRepoFullName accepts a valid owner and repository pair', () => {
  expect(splitRepoFullName('octo/example.repo')).toStrictEqual({
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
    expect(() => splitRepoFullName(value)).toThrow(
      /Invalid repository full name/
    )
  }
})
