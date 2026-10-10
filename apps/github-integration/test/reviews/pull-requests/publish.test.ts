import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePullRequestReviewRun } from '../../../src/reviews/pull-requests/publish.js'
import { setGitHubAppMetadata } from '../../../src/github/github-app-metadata-service.js'

const stepStore = {
  initializePublicationSteps: async () => {},
  listPublicationSteps: async () => [{ step_key: 'pull-request:review', status: 'pending' }],
  requirePublicationStepClaim: async () => {},
  completePublicationStep: async () => true,
  failPublicationStep: async () => true
}

function pullRequestContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    previous_head_sha: null,
    repo_name: 'example',
    repo_full_name: 'octo/example',
    owner_login: 'octo',
    sender_login: 'alice',
    pr_number: 7,
    pr_title: 'Improve security checks',
    pr_body: null,
    pr_author: 'alice',
    is_draft: false,
    base_ref: 'main',
    base_sha: 'base-sha',
    head_ref: 'feature',
    head_sha: 'head-sha',
    commits: 1,
    changed_files: 1,
    additions: 2,
    deletions: 1,
    html_url: 'https://example.test/octo/example/pull/7',
    api_url: 'https://api.example.test/repos/octo/example/pulls/7',
    commits_url: 'https://api.example.test/repos/octo/example/pulls/7/commits',
    review_comments_url: 'https://api.example.test/repos/octo/example/pulls/7/comments',
    comments_url: 'https://api.example.test/repos/octo/example/issues/7/comments',
    issue_url: 'https://api.example.test/repos/octo/example/issues/7',
    head_repo_full_name: 'octo/example',
    base_repo_full_name: 'octo/example',
    from_fork: false,
    ...overrides
  }
}

function review_record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysis: {
      verdict: 'confirmed-vulnerability',
      overview: 'The PR needs a security review response.',
      narratives: []
    },
    mitigation: {
      overview: null,
      changed_files: [],
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: null,
      review_target_claim: null,
      validation_level: null,
      patch_coverage: null,
      regression_status: null,
      resolution_next_step: null,
      patch_findings: [],
      verification_findings: [],
      residual_risks: []
    },
    cvss: null,
    ...overrides
  }
}

test('pull request publish leaves confirmed risks as non-blocking comments without inline suggestions', async () => {
  const issueComments: unknown[] = []
  const pullReviews: unknown[] = []
  const completed: unknown[] = []
  const store = {
    ...stepStore,
    completePublicationStep: async (...args: unknown[]) => {
      completed.push(args)
      return true
    }
  }
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: unknown) => {
          issueComments.push(args)
          return { data: { id: 1, html_url: 'https://example.test/comment/1' } }
        }
      },
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          return {
            data: {
              id: 2,
              html_url: 'https://example.test/review/2',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  }

  await handlePullRequestReviewRun({
    run: {
      run_id: 'run-1',
      publish_context: {
        pr: pullRequestContext(),
        files: [],
        event_type: 'manual_review'
      }
    },
    result: {
      contract_version: 'v5',
      review_record: review_record()
    },
    store: store as never,
    claim_token: 'test-claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => octokit
  })

  assert.equal(issueComments.length, 0)
  assert.equal(pullReviews.length, 1)
  const reviewArgs = pullReviews[0] as {
    body: string
    comments: unknown[]
    commit_id: string
    event: string
    owner: string
    pull_number: number
    repo: string
  }
  assert.deepEqual(
    {
      ...reviewArgs,
      body: '<body>'
    },
    {
      owner: 'octo',
      repo: 'example',
      pull_number: 7,
      commit_id: 'head-sha',
      body: '<body>',
      event: 'COMMENT',
      comments: []
    }
  )
  assert.match(reviewArgs.body, /<!-- sec-review-bot:pull-request-review-run:run-1 -->/)
  assert.match(reviewArgs.body, /## PR Security Review/)
  assert.deepEqual(completed, [
    ['run-1', 'test-claim', 'pull-request:review', { id: 2, url: 'https://example.test/review/2' }]
  ])
})

test('pull request publish leaves plausible risks as non-blocking comments', async () => {
  const pullReviews: unknown[] = []
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          return {
            data: {
              id: 2,
              html_url: 'https://example.test/review/2',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  }

  await handlePullRequestReviewRun({
    run: {
      run_id: 'run-plausible',
      publish_context: {
        pr: pullRequestContext(),
        files: [],
        event_type: 'manual_review'
      }
    },
    result: {
      contract_version: 'v5',
      review_record: review_record({
        analysis: {
          verdict: 'plausible-risk',
          overview: 'The trust boundary requires manual review.',
          narratives: []
        },
        verification: {
          overview: 'Exploitability is not confirmed.',
          review_target_claim: null,
          validation_level: 'static',
          patch_coverage: 'no-patch',
          regression_status: 'not-applicable',
          resolution_next_step: 'manual-review',
          patch_findings: [],
          verification_findings: [],
          residual_risks: ['Review the deployment trust boundary.']
        }
      })
    },
    store: stepStore as never,
    claim_token: 'test-claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => octokit
  })

  assert.equal(pullReviews.length, 1)
  assert.equal((pullReviews[0] as { event: string }).event, 'COMMENT')
})

test('pull request publish approves when analysis is not confirmed', async () => {
  const issueComments: unknown[] = []
  const pullReviews: unknown[] = []
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: unknown) => {
          issueComments.push(args)
          return { data: { id: 1, html_url: 'https://example.test/comment/1' } }
        }
      },
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          return {
            data: {
              id: 2,
              html_url: 'https://example.test/review/2',
              state: 'APPROVED'
            }
          }
        }
      }
    }
  }

  await handlePullRequestReviewRun({
    run: {
      run_id: 'run-1',
      publish_context: {
        pr: pullRequestContext(),
        files: [],
        event_type: 'manual_review'
      }
    },
    result: {
      contract_version: 'v5',
      review_record: review_record({
        analysis: {
          verdict: 'no-actionable-finding',
          overview: 'No actionable security issue remains in this PR.',
          narratives: []
        },
        mitigation: {
          overview: null,
          changed_files: [],
          file_changes: [],
          patch_diff: null
        },
        verification: {
          overview: null,
          review_target_claim: null,
          validation_level: null,
          patch_coverage: 'not-applicable',
          regression_status: 'not-applicable',
          resolution_next_step: null,
          patch_findings: [],
          verification_findings: [],
          residual_risks: []
        }
      })
    },
    store: stepStore as never,
    claim_token: 'test-claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => octokit
  })

  assert.equal(issueComments.length, 0)
  assert.equal(pullReviews.length, 1)
  assert.equal((pullReviews[0] as { event: string }).event, 'APPROVE')
})

test('pull request publish comments instead of approving a PR authored by the app bot', async () => {
  setGitHubAppMetadata({ slug: 'web-sec-bot' })
  const pullReviews: unknown[] = []
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          return {
            data: {
              id: 3,
              html_url: 'https://example.test/review/3',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  }

  try {
    await handlePullRequestReviewRun({
      run: {
        run_id: 'run-1',
        publish_context: {
          pr: pullRequestContext({ pr_author: 'web-sec-bot[bot]' }),
          files: [],
          event_type: 'manual_review'
        }
      },
      result: {
        contract_version: 'v5',
        review_record: review_record({
          analysis: {
            verdict: 'no-actionable-finding',
            overview: 'No actionable security issue remains in this PR.',
            narratives: []
          }
        })
      },
      store: stepStore as never,
      claim_token: 'test-claim',
      assert_publication_claim: async () => {},
      installation_octokit_for_repo: async () => octokit
    })
  } finally {
    setGitHubAppMetadata()
  }

  assert.deepEqual(
    pullReviews.map((item) => (item as { event: string }).event),
    ['COMMENT']
  )
})

test('pull request publish falls back to comment when GitHub rejects own PR approval', async () => {
  const pullReviews: unknown[] = []
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          if ((args as { event: string }).event === 'APPROVE') {
            const error = new Error('Unprocessable Entity')
            Object.assign(error, {
              response: {
                status: 422,
                data: {
                  errors: ['Review Can not approve your own pull request']
                }
              }
            })
            throw error
          }
          return {
            data: {
              id: 3,
              html_url: 'https://example.test/review/3',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  }

  await handlePullRequestReviewRun({
    run: {
      run_id: 'run-1',
      publish_context: {
        pr: pullRequestContext(),
        files: [],
        event_type: 'manual_review'
      }
    },
    result: {
      contract_version: 'v5',
      review_record: review_record({
        analysis: {
          verdict: 'no-actionable-finding',
          overview: 'No actionable security issue remains in this PR.',
          narratives: []
        }
      })
    },
    store: stepStore as never,
    claim_token: 'test-claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => octokit
  })

  assert.deepEqual(
    pullReviews.map((item) => (item as { event: string }).event),
    ['APPROVE', 'COMMENT']
  )
})

test('pull request publish falls back to comment when own PR approval error is in response message', async () => {
  const pullReviews: unknown[] = []
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          if ((args as { event: string }).event === 'APPROVE') {
            const error = new Error('Unprocessable Entity')
            Object.assign(error, {
              response: {
                status: 422,
                data: {
                  message: 'Review cannot approve your own pull request',
                  errors: []
                }
              }
            })
            throw error
          }
          return {
            data: {
              id: 3,
              html_url: 'https://example.test/review/3',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  }

  await handlePullRequestReviewRun({
    run: {
      run_id: 'run-1',
      publish_context: {
        pr: pullRequestContext(),
        files: [],
        event_type: 'manual_review'
      }
    },
    result: {
      contract_version: 'v5',
      review_record: review_record({
        analysis: {
          verdict: 'no-actionable-finding',
          overview: 'No actionable security issue remains in this PR.',
          narratives: []
        }
      })
    },
    store: stepStore as never,
    claim_token: 'test-claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => octokit
  })

  assert.deepEqual(
    pullReviews.map((item) => (item as { event: string }).event),
    ['APPROVE', 'COMMENT']
  )
})

test('pull request publish leaves confirmed risks as non-blocking comments with inline suggestions', async () => {
  const pullReviews: unknown[] = []
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          pullReviews.push(args)
          return {
            data: {
              id: 2,
              html_url: 'https://example.test/review/2',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  }

  await handlePullRequestReviewRun({
    run: {
      run_id: 'run-1',
      publish_context: {
        pr: pullRequestContext(),
        files: [
          {
            filename: 'src/server.js',
            patch: '@@ -1 +1 @@'
          }
        ],
        event_type: 'manual_review'
      }
    },
    result: {
      contract_version: 'v5',
      review_record: review_record({
        mitigation: {
          overview: 'Remove the unsafe default.',
          changed_files: ['src/server.js'],
          file_changes: [],
          patch_diff: [
            'diff --git a/src/server.js b/src/server.js',
            'index 1111111..2222222 100644',
            '--- a/src/server.js',
            '+++ b/src/server.js',
            '@@ -1 +1 @@',
            "-const token = 'debug'",
            '+const token = process.env.TOKEN'
          ].join('\n')
        },
        verification: {
          overview: 'The reviewed PR is safe.',
          review_target_claim: null,
          validation_level: 'static',
          patch_coverage: 'full',
          regression_status: 'not-run',
          resolution_next_step: 'none',
          patch_findings: [],
          verification_findings: [],
          residual_risks: []
        }
      })
    },
    store: stepStore as never,
    claim_token: 'test-claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => octokit
  })

  assert.equal(pullReviews.length, 1)
  assert.equal((pullReviews[0] as { event: string }).event, 'COMMENT')
  assert.equal((pullReviews[0] as { comments: unknown[] }).comments.length, 1)
})

test('pull request publish does not create a fallback review after an uncertain suggestion submission', async () => {
  let createCalls = 0
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async () => {
          createCalls += 1
          throw new Error('connection reset after request body was sent')
        }
      }
    }
  }

  await assert.rejects(
    handlePullRequestReviewRun({
      run: {
        run_id: 'run-uncertain',
        publish_context: {
          pr: pullRequestContext(),
          files: [{ filename: 'src/server.js', patch: '@@ -1 +1 @@' }],
          event_type: 'manual_review'
        }
      },
      result: {
        contract_version: 'v5',
        review_record: review_record({
          mitigation: {
            overview: 'Remove the unsafe default.',
            changed_files: ['src/server.js'],
            file_changes: [],
            patch_diff: [
              'diff --git a/src/server.js b/src/server.js',
              'index 1111111..2222222 100644',
              '--- a/src/server.js',
              '+++ b/src/server.js',
              '@@ -1 +1 @@',
              "-const token = 'debug'",
              '+const token = process.env.TOKEN'
            ].join('\n')
          }
        })
      },
      store: stepStore as never,
      claim_token: 'test-claim',
      assert_publication_claim: async () => {},
      installation_octokit_for_repo: async () => octokit
    }),
    /connection reset/
  )

  assert.equal(createCalls, 1)
})
