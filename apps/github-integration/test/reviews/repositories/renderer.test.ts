import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRepositorySummaryWorkflowView,
  buildDeliveryDraftPrBody,
  renderRepositorySecuritySummaryComment
} from '../../../reviews/repositories/renderer.js'

test('repository renderer derives blocked confirmed case cards from case results', () => {
  const body = renderRepositorySecuritySummaryComment({
    _repo: {
      repo_full_name: 'octo-org/example',
      owner_login: 'octo-org',
      repo_name: 'example'
    },
    workflow_result: {
      run_id: 'run-1',
      scan_summary: {
        scannable_file_count: 1,
        scanned_file_count: 1,
        case_count: 1,
        suppressed_candidate_count: 0
      },
      case_results: [
        {
          case_id: 'case-1',
          disposition: 'blocked',
          reason: 'The verifier did not fully approve the patch.',
          review_record: {
            analysis: {
              verdict: 'confirmed-defect',
              overview: 'Webhook retry payloads can reuse stale signature metadata.'
            },
            cvss: {
              base_score: 5.8,
              severity: 'medium',
              vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N',
              overview: 'This can allow replay through the internal queue.'
            },
            mitigation: {
              overview: 'The attempted patch covers direct webhook requests only.',
              patch_diff: 'diff --git a/src/webhook.ts b/src/webhook.ts\n+verifyRetrySignature()'
            },
            verification: {
              patch_coverage: 'partial',
              regression_status: 'not-run',
              validation_level: 'static',
              resolution_next_step: 'Manual review needed.',
              overview: 'Queued retry payloads remain unverified.'
            }
          }
        }
      ]
    },
    published_delivery_entries: [],
    event_type: 'manual',
    target_branch: 'main'
  })

  assert.match(body, /Blocked confirmed cases: `1`/)
  assert.match(body, /### Blocked Confirmed Cases/)
  assert.match(body, /<summary>\[medium\] case-1/)
  assert.match(body, /<summary>Analysis<\/summary>/)
  assert.match(body, /<summary>CVSS<\/summary>/)
  assert.match(body, /<summary>Mitigation<\/summary>/)
  assert.match(body, /<summary>Reference patch<\/summary>/)
  assert.match(body, /```diff\n(?:.|\n)*verifyRetrySignature/)
  assert.match(body, /<summary>Verification<\/summary>/)
  assert.ok(body.indexOf('<summary>Analysis</summary>') < body.indexOf('<summary>CVSS</summary>'))
  assert.ok(body.indexOf('<summary>CVSS</summary>') < body.indexOf('<summary>Mitigation</summary>'))
  assert.ok(body.indexOf('<summary>Mitigation</summary>') < body.indexOf('<summary>Verification</summary>'))
})

test('repository blocked confirmed case uses disposition reason as mitigation and verification fallback', () => {
  const body = renderRepositorySecuritySummaryComment({
    _repo: { repo_full_name: 'octo-org/example' },
    workflow_result: {
      run_id: 'run-1',
      case_results: [
        {
          case_id: 'case-1',
          disposition: 'blocked',
          reason: 'Verifier rejected the incomplete patch.',
          review_record: {
            analysis: {
              verdict: 'confirmed-vulnerability',
              overview: 'Signed webhook retries can be replayed.'
            },
            mitigation: {},
            verification: {
              patch_coverage: 'partial',
              regression_status: 'not-run',
              validation_level: 'static'
            }
          }
        }
      ]
    },
    published_delivery_entries: [],
    event_type: 'manual',
    target_branch: 'main'
  })

  assert.match(body, /<summary>Mitigation<\/summary>\n\nVerifier rejected the incomplete patch\./)
  assert.match(body, /<summary>Verification<\/summary>\n\nVerifier rejected the incomplete patch\./)
  assert.doesNotMatch(body, /No mitigation overview was recorded\./)
  assert.doesNotMatch(body, /No verification overview was recorded\./)
})

test('repository renderer preserves CVSS not-scored state', () => {
  const summary = renderRepositorySecuritySummaryComment({
    _repo: { repo_full_name: 'octo-org/example' },
    workflow_result: {
      run_id: 'run-1',
      case_results: [
        {
          review_record: {
            cvss: {
              base_score: 7.2,
              severity: 'high'
            }
          }
        },
        {
          review_record: {
            cvss: {
              outcome: 'not-scored'
            }
          }
        }
      ]
    },
    published_delivery_entries: [
      {
        case_count: 1,
        cvss_outcome: 'not-scored',
        cvss_base_score: null,
        cvss_severity: null,
        title: '[sec] container-runs-as-root',
        html_url: 'https://example.test/pull/1'
      }
    ],
    event_type: 'manual',
    target_branch: 'main'
  })

  assert.match(summary, /CVSS scored cases: `1`/)
  assert.match(summary, /CVSS not-scored cases: `1`/)
  assert.match(summary, /Case CVSS severities: `critical=0`, `high=1`/)
  assert.match(summary, /Grouped by each delivery PR's highest case CVSS severity\./)
  assert.match(summary, /#### not-scored \(1\)/)
  assert.match(summary, /\[CVSS not-scored\] \[sec\] container-runs-as-root/)
  assert.doesNotMatch(summary, /\[CVSS 0\.0\]/)

  const body = buildDeliveryDraftPrBody({
    repo: { repo_full_name: 'octo-org/example' },
    delivery: {
      delivery_id: 'delivery-1',
      case_ids: ['case-1'],
      case_count: 1
    },
    case_results: [
      {
        case_id: 'case-1',
        review_record: {
          cvss: {
            outcome: 'not-scored'
          }
        }
      }
    ]
  })

  assert.match(body, /Outcome: `not-scored`/)
  assert.match(body, /## Case Details/)
  assert.doesNotMatch(body, /#### Case Summary/)
  assert.doesNotMatch(body, /Verdict: `confirmed-defect`/)
  assert.doesNotMatch(body, /Affected paths:/)
  assert.doesNotMatch(body, /##### Evidence anchors/)
  assert.doesNotMatch(body, /Patch coverage: `full`/)
  assert.doesNotMatch(body, /Resolution next step: `none`/)
  assert.doesNotMatch(body, /Case disposition: `keep`/)
  assert.doesNotMatch(body, /Analyzer verdict: `confirmed-defect`/)
  assert.doesNotMatch(body, /## Delivery CVSS/)
  assert.match(body, /<summary>CVSS<\/summary>/)
  assert.doesNotMatch(body, /<!-- case-level mitigation overview -->/)
  assert.doesNotMatch(body, /#### Mitigation notes/)
  assert.doesNotMatch(body, /- Outcome: `patched`/)
  assert.doesNotMatch(body, /Reviewer-visible concern\./)
  assert.doesNotMatch(body, /##### Residual risks/)
  assert.doesNotMatch(body, /^#### Evidence$/m)
  assert.doesNotMatch(body, /#### Analyzer Result/)
  assert.doesNotMatch(body, /#### CVSS Scoring/)
  assert.doesNotMatch(body, /<summary>Audit metadata<\/summary>/)
  assert.doesNotMatch(body, /This is hardening, not an independent vulnerability\./)
  assert.doesNotMatch(body, /CVSS v4 base score: `n\/a` \(`unknown`\)/)
  assert.doesNotMatch(body, /Review target claim: \(none\)/)
})

test('repository summary workflow view keeps minimal case fields for rendering', () => {
  const view = buildRepositorySummaryWorkflowView(
    {
      cases: [{ summary: 'Retained triage case' }],
      scan_summary: {
        case_count: 1
      },
      case_results: [
        {
          case_id: 'case-1',
          disposition: 'keep'
        }
      ]
    },
    { run_id: 'run-1' }
  )

  assert.deepEqual(view, {
    run_id: 'run-1',
    scan_summary: {
      scannable_file_count: 0,
      scanned_file_count: 0,
      skipped_file_count: 0,
      candidate_count: 0,
      case_count: 1,
      suppressed_candidate_count: 0
    },
    cvss_summary: {
      scored_case_count: 0,
      not_scored_case_count: 0,
      unscored_case_count: 1,
      severity_counts: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        none: 0,
        unknown: 0
      }
    },
    case_results: [
      {
        case_id: 'case-1',
        disposition: 'keep',
        reason: null,
        review_record: {}
      }
    ]
  })
})

test('repository draft PR body lists delivery modified files', () => {
  const body = buildDeliveryDraftPrBody({
    repo: { repo_full_name: 'octo-org/example' },
    delivery: {
      delivery_id: 'delivery-1',
      file_changes: [{ path: 'src/server.js' }],
      case_ids: ['case-1'],
      case_count: 1
    }
  })

  assert.match(body, /## Modified Files/)
  assert.match(body, /- `src\/server\.js`/)
  assert.doesNotMatch(body, /Removed sensitive health metadata/)
})

test('repository draft PR body renders case details from case results', () => {
  const body = buildDeliveryDraftPrBody({
    repo: { repo_full_name: 'octo-org/example' },
    delivery: {
      delivery_id: 'delivery-1',
      file_changes: [{ path: 'src/server.js' }],
      case_ids: ['case-1'],
      case_count: 1
    },
    case_results: [
      {
        case_id: 'case-1',
        review_record: {
          analysis: {
            verdict: 'confirmed-defect',
            overview: 'Preview endpoint exposed repository files.'
          },
          cvss: {
            base_score: 8.7,
            severity: 'high',
            vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N',
            overview: 'High confidentiality impact.'
          },
          mitigation: {
            overview: 'Restrict preview root.'
          },
          verification: {
            patch_coverage: 'full',
            regression_status: 'not-run',
            resolution_next_step: 'none',
            validation_level: 'static',
            patch_findings: ['Reviewer-visible concern.'],
            verification_findings: []
          }
        }
      }
    ]
  })

  assert.match(body, /## Case Details/)
  assert.match(body, /<summary>View case case-1<\/summary>/)
  assert.match(body, /Analyzer verdict: `confirmed-defect`/)
  assert.match(body, /<summary>Analysis<\/summary>/)
  assert.match(body, /<summary>CVSS<\/summary>/)
  assert.match(body, /<summary>Mitigation<\/summary>/)
  assert.match(body, /<summary>Verification<\/summary>/)
  assert.match(body, /Restrict preview root\./)
  assert.match(body, /Reviewer-visible concern\./)
  assert.doesNotMatch(body, /delivery\.cases/)
})

test('repository draft PR case details use delivery fallback text', () => {
  const body = buildDeliveryDraftPrBody({
    repo: { repo_full_name: 'octo-org/example' },
    delivery: {
      delivery_id: 'delivery-1',
      case_ids: ['case-1'],
      case_count: 1
    },
    case_results: [
      {
        case_id: 'case-1',
        review_record: {
          analysis: {
            verdict: 'confirmed-defect',
            overview: 'Preview endpoint exposed repository files.'
          },
          mitigation: {},
          verification: {
            patch_coverage: 'full',
            regression_status: 'not-run',
            validation_level: 'static'
          }
        }
      }
    ]
  })

  assert.match(body, /<summary>Mitigation<\/summary>\n\nNo mitigation overview was recorded\./)
  assert.match(body, /<summary>Verification<\/summary>\n\nNo verification overview was recorded\./)
  assert.doesNotMatch(body, /Verifier rejected the incomplete patch\./)
})

test('repository summary notes shared modified files across deliveries', () => {
  const body = renderRepositorySecuritySummaryComment({
    _repo: { repo_full_name: 'octo-org/example' },
    workflow_result: {
      run_id: 'run-1'
    },
    published_delivery_entries: [
      {
        delivery_id: 'case-1',
        case_count: 1,
        cvss_outcome: null,
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [{ path: 'src/server.js' }],
        title: '[sec] first',
        html_url: 'https://example.test/pull/1'
      },
      {
        delivery_id: 'case-2',
        case_count: 1,
        cvss_outcome: null,
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [{ path: 'src/server.js' }],
        title: '[sec] second',
        html_url: 'https://example.test/pull/2'
      },
      {
        delivery_id: 'case-3',
        case_count: 1,
        cvss_outcome: null,
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [{ path: 'Dockerfile' }],
        title: '[sec] third',
        html_url: 'https://example.test/pull/3'
      }
    ],
    event_type: 'manual',
    target_branch: 'main'
  })

  assert.match(body, /### Coordination Notes/)
  assert.match(body, /Shared modified file `src\/server\.js`/)
  assert.match(body, /\[`case-1`\]\(https:\/\/example\.test\/pull\/1\)/)
  assert.match(body, /\[`case-2`\]\(https:\/\/example\.test\/pull\/2\)/)
  assert.match(body, /These delivery PRs touch the same file; review publish order if publishing them together\./)
  assert.doesNotMatch(body, /Shared modified file `Dockerfile`/)
})
