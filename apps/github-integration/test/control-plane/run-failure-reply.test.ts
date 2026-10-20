// Verifies a failure notice resolves its target repository without posting to the wrong one.
import assert from 'node:assert/strict'
import test from 'node:test'

import { sendRunFailureReply } from '../../src/control-plane/run-failure-reply.js'
import { repositoryFullName } from '../../src/github/repository-service.js'

function stubOctokit(
  report: {
    created: Array<{ owner: string; repo: string }>
    commented: number[]
    /** Repositories this installation may see; anything else answers 404 like GitHub does. */
    installed?: string[]
  },
  options: { repoLookupFailsWith?: number } = {}
): never {
  const installed = new Set(report.installed ?? [])
  return {
    rest: {
      repos: {
        get: async ({ owner, repo }: { owner: string; repo: string }) => {
          if (options.repoLookupFailsWith !== undefined) {
            throw Object.assign(new Error('lookup failed'), {
              status: options.repoLookupFailsWith
            })
          }
          if (!installed.has(`${owner}/${repo}`)) {
            throw Object.assign(new Error('Not Found'), { status: 404 })
          }
          return { data: { full_name: `${owner}/${repo}` } }
        }
      },
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
      commented: [] as number[],
      // Mark every plausible target installed, so this assertion is about *resolution* and not
      // about the installation guard accidentally rejecting the value.
      installed: ['octo', 'octo/example', 'a/b', 'example'].map((repo) =>
        repo.includes('/') ? repo : `x/${repo}`
      )
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
    commented: [] as number[],
    installed: ['octo/example']
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
      commented: [] as number[],
      installed: ['octo/example']
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

test('a target repository outside the installation is refused before any write', async () => {
  // Persisted state names a repository this app is not installed on. The installation-scoped
  // client answers 404, so the reply path must refuse rather than create a summary issue or a
  // comment there - otherwise a bad persisted value becomes a public write in a foreign repo.
  for (const input of [
    { kind: 'github_repository_review', verified_repository: 'attacker/repo' },
    {
      kind: 'github_issue_review',
      issue: { owner_login: 'attacker', repo_name: 'repo', issue_number: 1 }
    },
    {
      kind: 'github_pull_request_review',
      pr_reference: { owner_login: 'attacker', repo_name: 'repo', pr_number: 2 }
    }
  ]) {
    const report = {
      created: [] as Array<{ owner: string; repo: string }>,
      commented: [] as number[],
      installed: ['octo/example']
    }
    await assert.rejects(
      sendRunFailureReply(stubOctokit(report), {
        run_id: 'run-foreign',
        input,
        failure_stage: 'preparation',
        failure_code: 'PREPARATION_RETRY_EXHAUSTED'
      }),
      /not installed on this app/,
      `${JSON.stringify(input)} must be refused`
    )
    assert.deepStrictEqual(report.created, [], 'no issue may be created')
    assert.deepStrictEqual(report.commented, [], 'no comment may be posted')
  }
})

test('a transient repository lookup fault stays retryable', async () => {
  // A 5xx from the repository lookup is the GitHub outage case: the notice must remain
  // retryable, so the error propagates unchanged (no deterministic status of 403/404 attached).
  const report = {
    created: [] as Array<{ owner: string; repo: string }>,
    commented: [] as number[],
    installed: ['octo/example']
  }
  await assert.rejects(
    sendRunFailureReply(stubOctokit(report, { repoLookupFailsWith: 502 }), {
      run_id: 'run-transient',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED'
    }),
    /lookup failed/
  )
  assert.deepStrictEqual(report.created, [])
})
