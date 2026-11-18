// Verifies a failure notice resolves its target repository without posting to the wrong one.
import { expect, test } from 'vitest'

import { classifyPreparationFailure } from '../../src/review-runs/preparation-failure.js'
import { sendRunNoticeReply } from '../../src/review-runs/run-notice-reply.js'
import { repositoryFullName } from '../../src/github/repository-service.js'
import type { Octokit } from 'octokit'
import { fakeGitHub, githubJson } from '../github-client.js'

const keepNoticeClaim = async (): Promise<void> => {}

/**
 * A real client whose transport serves the endpoints `sendRunNoticeReply` uses, recording what it
 * was asked to create.
 *
 * `installed` is the set of repositories GitHub answers for; anything else is a 404, which is how
 * a real installation behaves for a repository it cannot see.
 */
function stubOctokit(
  report: {
    created: Array<{ owner: string; repo: string }>
    commented: number[]
    /** The body of each comment the reply path posted, so its wording can be asserted. */
    bodies?: string[]
    installed?: string[]
  },
  options: { repoLookupFailsWith?: number } = {}
): Octokit {
  const installed = new Set(report.installed ?? [])
  const { octokit } = fakeGitHub(({ method, url, body }) => {
    const parsed = new URL(url)
    const pathname = parsed.pathname
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname)
    const owner = repoMatch?.[1] ?? ''
    const repo = repoMatch?.[2] ?? ''
    const tail = repoMatch?.[3] ?? ''

    // The installation guard reads the repository first.
    if (tail === '') {
      if (options.repoLookupFailsWith !== undefined) {
        return githubJson({ message: 'Server Error' }, options.repoLookupFailsWith)
      }
      if (!installed.has(`${owner}/${repo}`)) {
        return githubJson({ message: 'Not Found' }, 404)
      }
      return githubJson({ full_name: `${owner}/${repo}` })
    }
    if (tail.endsWith('/issues') && method === 'GET') {
      return githubJson([])
    }
    if (tail.endsWith('/issues') && method === 'POST') {
      report.created.push({ owner, repo })
      return githubJson({ number: 9 })
    }
    if (tail.endsWith('/comments') && method === 'GET') {
      return githubJson([])
    }
    if (tail.endsWith('/comments') && method === 'POST') {
      report.commented.push(Number(tail.split('/').at(-2)))
      const posted = body as { body?: unknown } | undefined
      if (typeof posted?.body === 'string') {
        report.bodies?.push(posted.body)
      }
      return githubJson({ id: 1, html_url: 'https://example.test/comment/1' })
    }
    return githubJson({})
  })
  return octokit
}

test('a repository failure target must be exactly owner/repo', async () => {
  // The value is read back from persisted notice state, so a malformed one must not be split
  // opportunistically: `a/b/c` truncated to `a/b` would report into a different repository than
  // the one that was scanned. Anything ambiguous counts as "no target", which the caller records
  // as an undelivered notice rather than posting somewhere misleading.
  for (const verified_repository of ['a/b/c', 'octo', '/example', 'octo/', '', '   ']) {
    const report = {
      created: [] as Array<{ owner: string; repo: string }>,
      commented: [] as number[],
      // Mark every plausible target installed, so this assertion is about *resolution* and not
      // about the installation guard accidentally rejecting the value.
      installed: ['octo', 'octo/example', 'a/b', 'example'].map((repo) =>
        repo.includes('/') ? repo : `x/${repo}`
      )
    }
    const result = await sendRunNoticeReply(stubOctokit(report), {
      run_id: 'run-repository',
      notice_id: 'notice-test',
      input: { kind: 'github_repository_review', verified_repository },
      axis: 'preparation',
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure',
      assert_notice_claim: keepNoticeClaim
    })
    expect(result, `${JSON.stringify(verified_repository)} must not resolve to a repository`).toBe(
      null
    )
    expect(report.created, 'no issue may be created for an invalid target').toStrictEqual([])
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
  const result = await sendRunNoticeReply(stubOctokit(report), {
    run_id: 'run-repository',
    notice_id: 'notice-test',
    input: {
      kind: 'github_repository_review',
      verified_repository: '  octo/example  '
    },
    axis: 'preparation',
    reason_code: 'PREPARATION_RETRY_EXHAUSTED',
    kind: 'failure',
    assert_notice_claim: keepNoticeClaim
  })
  expect(report.created).toStrictEqual([{ owner: 'octo', repo: 'example' }])
  expect(report.commented).toStrictEqual([9])
  expect(result?.comment_url).toBe('https://example.test/comment/1')
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
    const result = await sendRunNoticeReply(stubOctokit(report), {
      run_id: 'run-agreement',
      notice_id: 'notice-test',
      input: { kind: 'github_repository_review', verified_repository },
      axis: 'preparation',
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure',
      assert_notice_claim: keepNoticeClaim
    })
    const namesARepository = repositoryFullName(verified_repository) !== null
    expect(
      result !== null,
      `${JSON.stringify(verified_repository)} must resolve the same way on both paths`
    ).toBe(namesARepository)
  }
})

test('an inaccessible target repository is refused before any write', async () => {
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
    await expect(
      sendRunNoticeReply(stubOctokit(report), {
        run_id: 'run-foreign',
        notice_id: 'notice-foreign',
        input,
        axis: 'preparation',
        reason_code: 'PREPARATION_RETRY_EXHAUSTED',
        kind: 'failure',
        assert_notice_claim: keepNoticeClaim
      }),
      `${JSON.stringify(input)} must be refused`
    ).rejects.toSatisfy((error: unknown) => {
      expect(classifyPreparationFailure(error, 1).retry).toBe(false)
      expect((error as { status: number }).status).toBe(404)
      return true
    })
    expect(report.created, 'no issue may be created').toStrictEqual([])
    expect(report.commented, 'no comment may be posted').toStrictEqual([])
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
  await expect(
    sendRunNoticeReply(stubOctokit(report, { repoLookupFailsWith: 502 }), {
      run_id: 'run-transient',
      notice_id: 'notice-test',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      axis: 'preparation',
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure',
      assert_notice_claim: keepNoticeClaim
    })
  ).rejects.toThrow(/Server Error/)
  expect(report.created).toStrictEqual([])
})

test('a notice without a failure code says so instead of inventing one', async () => {
  // The contract allows `reason_code: null`. Substituting `${stage}_FAILED` printed a code that
  // exists neither in the coordination vocabulary nor in the console's explanations, so a reader
  // saw a plausible-looking reason that was never recorded anywhere.
  const report = {
    created: [] as Array<{ owner: string; repo: string }>,
    commented: [] as number[],
    bodies: [] as string[],
    installed: ['octo/example']
  }
  await sendRunNoticeReply(stubOctokit(report), {
    run_id: 'run-no-code',
    notice_id: 'notice-test',
    input: {
      kind: 'github_repository_review',
      verified_repository: 'octo/example'
    },
    axis: 'execution',
    reason_code: null,
    kind: 'failure',
    assert_notice_claim: keepNoticeClaim
  })

  expect(report.bodies).toHaveLength(1)
  const body = report.bodies[0]!
  expect(body, 'no synthesized code may appear').not.toMatch(/[A-Z_]+_FAILED/)
  expect(body, 'there is no reason to state').not.toMatch(/Reason:/)
  expect(body).toMatch(/no failure code/i)
  expect(body, 'the run is still identified').toMatch(/run-no-code/)
})

test('a notice with a failure code still states it', async () => {
  const report = {
    created: [] as Array<{ owner: string; repo: string }>,
    commented: [] as number[],
    bodies: [] as string[],
    installed: ['octo/example']
  }
  await sendRunNoticeReply(stubOctokit(report), {
    run_id: 'run-with-code',
    notice_id: 'notice-test',
    input: {
      kind: 'github_repository_review',
      verified_repository: 'octo/example'
    },
    axis: 'execution',
    reason_code: 'EXECUTION_RESULT_MISSING',
    kind: 'failure',
    assert_notice_claim: keepNoticeClaim
  })

  expect(report.bodies).toHaveLength(1)
  expect(report.bodies[0]!).toMatch(/Reason: `EXECUTION_RESULT_MISSING`\./)
})

test('a lost notice claim stops before the public comment write', async () => {
  const report = {
    created: [] as Array<{ owner: string; repo: string }>,
    commented: [] as number[],
    installed: ['octo/example']
  }

  await expect(
    sendRunNoticeReply(stubOctokit(report), {
      run_id: 'run-resumed',
      notice_id: 'notice-superseded',
      input: {
        kind: 'github_issue_review',
        issue: {
          owner_login: 'octo',
          repo_name: 'example',
          issue_number: 7
        }
      },
      axis: 'preparation',
      reason_code: 'PREPARATION_RECOVERY_EXHAUSTED',
      kind: 'attention',
      assert_notice_claim: async () => {
        throw new Error('notice claim lost')
      }
    })
  ).rejects.toThrow(/notice claim lost/)
  expect(report.created).toStrictEqual([])
  expect(
    report.commented,
    'the repository may be read, but no comment may be written after claim loss'
  ).toStrictEqual([])
})

for (const limited of [true, false]) {
  test(`repository lookup 403 preserves retryability: rate limited=${limited}`, async () => {
    const { octokit } = fakeGitHub(
      () =>
        new Response(
          JSON.stringify({
            message: limited ? 'API rate limit exceeded' : 'Forbidden'
          }),
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
              ...(limited ? { 'retry-after': '60', 'x-ratelimit-remaining': '0' } : {})
            }
          }
        )
    )
    await expect(
      sendRunNoticeReply(octokit, {
        run_id: 'run-limited',
        notice_id: 'notice-limited',
        input: {
          issue: { owner_login: 'octo', repo_name: 'example', issue_number: 1 }
        },
        axis: 'execution',
        kind: 'failure',
        reason_code: null,
        assert_notice_claim: keepNoticeClaim
      })
    ).rejects.toSatisfy((error: unknown) => {
      const classification = classifyPreparationFailure(error, 1)
      expect(classification.retry).toBe(limited)
      if (limited) {
        expect(classification.retryAfterMs).toBe(60_000)
      }
      return true
    })
  })
}
