// Verifies a failure notice resolves its target repository without posting to the wrong one.
import assert from 'node:assert/strict'
import test from 'node:test'

import { sendRunFailureReply } from '../../src/control-plane/run-failure-reply.js'
import { repositoryFullName } from '../../src/github/repository-service.js'

function stubOctokit(report: {
  created: Array<{ owner: string; repo: string }>
  commented: number[]
}): never {
  return {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        create: async (args: { owner: string; repo: string }) => {
          report.created.push({ owner: args.owner, repo: args.repo })
          return { data: { number: 9 } }
        },
        listComments: async () => ({ data: [] }),
        createComment: async (args: { issue_number: number }) => {
          report.commented.push(args.issue_number)
          return { data: { id: 1, html_url: 'https://example.test/comment/1' } }
        }
      }
    }
  } as never
}

test('a repository failure target must be exactly owner/repo', async () => {
  // The value is read back from persisted notice state, so a malformed one must not be split
  // opportunistically: `a/b/c` truncated to `a/b` would report into a different repository than
  // the one that was scanned. Anything ambiguous counts as "no target", which the caller records
  // as an undelivered notice rather than posting somewhere misleading.
  for (const verified_repository of [
    'a/b/c',
    'octo',
    '/example',
    'octo/',
    '',
    '   '
  ]) {
    const report = {
      created: [] as Array<{ owner: string; repo: string }>,
      commented: [] as number[]
    }
    const result = await sendRunFailureReply(stubOctokit(report), {
      run_id: 'run-repository',
      input: { kind: 'github_repository_review', verified_repository },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED'
    })
    assert.strictEqual(
      result,
      null,
      `${JSON.stringify(verified_repository)} must not resolve to a repository`
    )
    assert.deepStrictEqual(
      report.created,
      [],
      'no issue may be created for an invalid target'
    )
  }
})

test('a repository failure target tolerates surrounding whitespace', async () => {
  // The coordinator trims the same value before using it as a repository key; the reply path has
  // to agree, or the name would keep the spaces and address a repository that does not exist.
  const report = {
    created: [] as Array<{ owner: string; repo: string }>,
    commented: [] as number[]
  }
  const result = await sendRunFailureReply(stubOctokit(report), {
    run_id: 'run-repository',
    input: {
      kind: 'github_repository_review',
      verified_repository: '  octo/example  '
    },
    failure_stage: 'preparation',
    failure_code: 'PREPARATION_RETRY_EXHAUSTED'
  })
  assert.deepStrictEqual(report.created, [{ owner: 'octo', repo: 'example' }])
  assert.deepStrictEqual(report.commented, [9])
  assert.strictEqual(result?.comment_url, 'https://example.test/comment/1')
})

test('the reply target and the installation lookup agree on what names a repository', async () => {
  // Both paths read the same persisted `verified_repository`. If one accepted a value the other
  // rejected, the installation lookup would throw on every attempt while the reply path believed
  // it had a target (or the reverse), and the notice would never settle. Sharing one normalizer
  // is what makes that impossible; this pins the agreement rather than the implementation.
  for (const verified_repository of [
    'octo/example',
    '  octo/example  ',
    'octo/example/extra',
    'octo',
    '/example',
    'octo/',
    '',
    '   '
  ]) {
    const report = {
      created: [] as Array<{ owner: string; repo: string }>,
      commented: [] as number[]
    }
    const result = await sendRunFailureReply(stubOctokit(report), {
      run_id: 'run-agreement',
      input: { kind: 'github_repository_review', verified_repository },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED'
    })
    const namesARepository = repositoryFullName(verified_repository) !== null
    assert.strictEqual(
      result !== null,
      namesARepository,
      `${JSON.stringify(verified_repository)} must resolve the same way on both paths`
    )
  }
})
