import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRepositorySummaryWorkflowView,
  buildDeliveryDraftPrBody,
  renderRepositorySecuritySummaryComment
} from '../../../src/reviews/repositories/renderer.js'
import {
  coverageHeadline,
  renderReviewStatusLines
} from '../../../src/reviews/view-utils.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'
import type {
  RepositoryCaseResult,
  RepositoryScanSummary,
  RepositoryWorkflowResult
} from '../../../src/reviews/repositories/result.js'

function reviewRecord(
  overrides: {
    analysis?: Partial<ReviewRecord['analysis']>
    mitigation?: Partial<ReviewRecord['mitigation']>
    verification?: Partial<ReviewRecord['verification']>
    cvss?: Partial<NonNullable<ReviewRecord['cvss']>> | null
  } = {}
): ReviewRecord {
  return {
    analysis: {
      verdict: null,
      overview: null,
      narratives: [],
      ...overrides.analysis
    },
    mitigation: {
      overview: null,
      file_changes: [],
      patch_diff: null,
      ...overrides.mitigation
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
      residual_risks: [],
      ...overrides.verification
    },
    cvss:
      overrides.cvss === undefined || overrides.cvss === null
        ? (overrides.cvss ?? null)
        : {
            outcome: null,
            base_score: null,
            severity: null,
            vector: null,
            overview: null,
            not_scored_reason: null,
            ...overrides.cvss
          }
  }
}

function scanSummary(
  overrides: Partial<RepositoryScanSummary> = {}
): RepositoryScanSummary {
  return {
    scannable_file_count: 0,
    scanned_file_count: 0,
    skipped_file_count: 0,
    candidate_count: 0,
    case_count: 0,
    suppressed_candidate_count: 0,
    deleted_file_count: 0,
    ...overrides
  }
}

function repositoryResult(
  case_results: RepositoryCaseResult[] = [],
  options: {
    scan_summary?: Partial<RepositoryScanSummary>
    deletion_review_skipped?: boolean
  } = {}
): RepositoryWorkflowResult {
  return {
    api_version: 'v1',
    scan_summary: scanSummary(options.scan_summary),
    case_results,
    deliveries: [],
    deletion_review_skipped: options.deletion_review_skipped ?? false
  }
}

function summaryView(
  case_results: RepositoryCaseResult[] = [],
  options: {
    scan_summary?: Partial<RepositoryScanSummary>
    deletion_review_skipped?: boolean
  } = {}
) {
  return buildRepositorySummaryWorkflowView(
    repositoryResult(case_results, options),
    { run_id: 'run-1' }
  )
}

test('repository renderer derives blocked confirmed case cards from case results', () => {
  const review_record = reviewRecord({
    analysis: {
      verdict: 'confirmed-defect',
      overview: 'Webhook retry payloads can reuse stale signature metadata.'
    },
    cvss: {
      outcome: 'scored',
      base_score: 5.8,
      severity: 'medium',
      vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N',
      overview: 'This can allow replay through the internal queue.'
    },
    mitigation: {
      overview: 'The attempted patch covers direct webhook requests only.',
      patch_diff:
        'diff --git a/src/webhook.ts b/src/webhook.ts\n+verifyRetrySignature()'
    },
    verification: {
      patch_coverage: 'partial',
      regression_status: 'not-run',
      validation_level: 'static',
      resolution_next_step: 'manual-review',
      overview: 'Queued retry payloads remain unverified.'
    }
  })
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView(
      [
        {
          case_id: 'case-1',
          disposition: 'blocked',
          reason: 'The verifier did not fully approve the patch.',
          review_record
        }
      ],
      {
        scan_summary: {
          scannable_file_count: 1,
          scanned_file_count: 1,
          case_count: 1,
          suppressed_candidate_count: 0
        }
      }
    ),
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
  assert.ok(
    body.indexOf('<summary>Analysis</summary>') <
      body.indexOf('<summary>CVSS</summary>')
  )
  assert.ok(
    body.indexOf('<summary>CVSS</summary>') <
      body.indexOf('<summary>Mitigation</summary>')
  )
  assert.ok(
    body.indexOf('<summary>Mitigation</summary>') <
      body.indexOf('<summary>Verification</summary>')
  )

  // The card reuses the shared status vocabulary instead of restating it, and the
  // title carries case identity rather than repeating the coverage rating.
  assert.ok(
    body.includes(
      renderReviewStatusLines({
        analysis: review_record.analysis,
        mitigation: review_record.mitigation,
        verification: review_record.verification
      }).join('\n')
    )
  )
  const titleLine = body
    .split('\n')
    .find((line) => line.startsWith('<summary>[medium] case-1'))
  assert.ok(titleLine)
  assert.ok(
    !titleLine.includes(
      coverageHeadline(review_record.verification.patch_coverage)
    )
  )
})

test('repository blocked confirmed case uses disposition reason as mitigation and verification fallback', () => {
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([
      {
        case_id: 'case-1',
        disposition: 'blocked',
        reason: 'Verifier rejected the incomplete patch.',
        review_record: reviewRecord({
          analysis: {
            verdict: 'confirmed-vulnerability',
            overview: 'Signed webhook retries can be replayed.'
          },
          verification: {
            patch_coverage: 'partial',
            regression_status: 'not-run',
            validation_level: 'static'
          }
        })
      }
    ]),
    published_delivery_entries: [],
    event_type: 'manual',
    target_branch: 'main'
  })

  assert.match(
    body,
    /<summary>Mitigation<\/summary>\n\nVerifier rejected the incomplete patch\./
  )
  assert.match(
    body,
    /<summary>Verification<\/summary>\n\nVerifier rejected the incomplete patch\./
  )
  assert.doesNotMatch(body, /No mitigation overview was recorded\./)
  assert.doesNotMatch(body, /No verification overview was recorded\./)
})

test('repository renderer preserves CVSS not-scored state', () => {
  const summary = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([
      {
        case_id: 'case-1',
        disposition: 'keep',
        reason: null,
        review_record: reviewRecord({
          cvss: {
            outcome: 'scored',
            base_score: 7.2,
            severity: 'high'
          }
        })
      },
      {
        case_id: 'case-2',
        disposition: 'keep',
        reason: null,
        review_record: reviewRecord({
          cvss: {
            outcome: 'not-scored'
          }
        })
      }
    ]),
    published_delivery_entries: [
      {
        delivery_id: 'delivery-1',
        case_count: 1,
        cvss_outcome: 'not-scored',
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [],
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
  assert.match(
    summary,
    /Grouped by each delivery PR's highest case CVSS severity\./
  )
  assert.match(summary, /#### not-scored \(1\)/)
  assert.match(summary, /\[CVSS not-scored\] \[sec\] container-runs-as-root/)
  assert.doesNotMatch(summary, /\[CVSS 0\.0\]/)

  const body = buildDeliveryDraftPrBody({
    repo: { repo_full_name: 'octo-org/example' },
    delivery: {
      delivery_id: 'delivery-1',
      file_changes: [],
      case_ids: ['case-1'],
      case_count: 1
    },
    case_results: [
      {
        case_id: 'case-1',
        disposition: 'keep',
        reason: null,
        review_record: reviewRecord({
          cvss: {
            outcome: 'not-scored'
          }
        })
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
  assert.doesNotMatch(body, /- Analysis: `confirmed security defect`/)
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
  assert.doesNotMatch(
    body,
    /This is hardening, not an independent vulnerability\./
  )
  assert.doesNotMatch(body, /CVSS v4 base score: `n\/a` \(`unknown`\)/)
  assert.doesNotMatch(body, /Review target claim: \(none\)/)
})

test('repository summary workflow view projects a validated repository result without reparsing', () => {
  const caseResult: RepositoryCaseResult = {
    case_id: 'case-1',
    disposition: 'keep',
    reason: null,
    review_record: reviewRecord()
  }
  const view = buildRepositorySummaryWorkflowView(
    repositoryResult([caseResult], { scan_summary: { case_count: 1 } }),
    { run_id: 'run-1' }
  )

  assert.deepStrictEqual(view, {
    run_id: 'run-1',
    deletion_review_skipped: false,
    scan_summary: {
      scannable_file_count: 0,
      scanned_file_count: 0,
      skipped_file_count: 0,
      candidate_count: 0,
      case_count: 1,
      suppressed_candidate_count: 0,
      deleted_file_count: 0
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
    case_results: [caseResult]
  })
})

test('repository draft PR body lists delivery modified files', () => {
  const body = buildDeliveryDraftPrBody({
    repo: { repo_full_name: 'octo-org/example' },
    delivery: {
      delivery_id: 'delivery-1',
      file_changes: [{ path: 'src/server.js', status: 'deleted' }],
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
      file_changes: [{ path: 'src/server.js', status: 'deleted' }],
      case_ids: ['case-1'],
      case_count: 1
    },
    case_results: [
      {
        case_id: 'case-1',
        disposition: 'keep',
        reason: null,
        review_record: reviewRecord({
          analysis: {
            verdict: 'confirmed-defect',
            overview: 'Preview endpoint exposed repository files.'
          },
          cvss: {
            outcome: 'scored',
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
        })
      }
    ]
  })

  assert.match(body, /## Case Details/)
  assert.match(body, /<summary>View case case-1<\/summary>/)
  assert.match(body, /- Analysis: `confirmed security defect`/)
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
      file_changes: [],
      case_ids: ['case-1'],
      case_count: 1
    },
    case_results: [
      {
        case_id: 'case-1',
        disposition: 'keep',
        reason: null,
        review_record: reviewRecord({
          analysis: {
            verdict: 'confirmed-defect',
            overview: 'Preview endpoint exposed repository files.'
          },
          verification: {
            patch_coverage: 'full',
            regression_status: 'not-run',
            validation_level: 'static'
          }
        })
      }
    ]
  })

  assert.match(
    body,
    /<summary>Mitigation<\/summary>\n\nNo mitigation overview was recorded\./
  )
  assert.match(
    body,
    /<summary>Verification<\/summary>\n\nNo verification overview was recorded\./
  )
  assert.doesNotMatch(body, /Verifier rejected the incomplete patch\./)
})

test('repository summary notes shared modified files across deliveries', () => {
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView(),
    published_delivery_entries: [
      {
        delivery_id: 'case-1',
        case_count: 1,
        cvss_outcome: null,
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [{ path: 'src/server.js', status: 'deleted' }],
        title: '[sec] first',
        html_url: 'https://example.test/pull/1'
      },
      {
        delivery_id: 'case-2',
        case_count: 1,
        cvss_outcome: null,
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [{ path: 'src/server.js', status: 'deleted' }],
        title: '[sec] second',
        html_url: 'https://example.test/pull/2'
      },
      {
        delivery_id: 'case-3',
        case_count: 1,
        cvss_outcome: null,
        cvss_base_score: null,
        cvss_severity: null,
        file_changes: [{ path: 'Dockerfile', status: 'deleted' }],
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
  assert.match(
    body,
    /These delivery PRs touch the same file; review publish order if publishing them together\./
  )
  assert.doesNotMatch(body, /Shared modified file `Dockerfile`/)
})

test('repository renderer warns when deletion review was skipped', () => {
  // A window over the deletion limit is a partial result that still completes successfully.
  // If the comment looks the same as a fully reviewed run, a reader has no way to know that none
  // of the window's deletions were examined.
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([], {
      deletion_review_skipped: true,
      scan_summary: {
        scannable_file_count: 3,
        scanned_file_count: 3,
        case_count: 0,
        suppressed_candidate_count: 0,
        deleted_file_count: 250
      }
    }),
    published_delivery_entries: [],
    event_type: 'scheduled',
    target_branch: 'main'
  })

  assert.match(body, /Deletion review skipped/)
  assert.match(body, /`250` files/)
  // The warning sits above the summary details, so skimming the top of the comment shows it.
  assert.ok(
    body.indexOf('Deletion review skipped') <
      body.indexOf('Scan summary details')
  )
  assert.match(body, /Deleted files in window: `250`/)
})

test('repository renderer stays quiet when deletion review ran', () => {
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([], {
      deletion_review_skipped: false,
      scan_summary: {
        scannable_file_count: 3,
        scanned_file_count: 3,
        case_count: 0,
        suppressed_candidate_count: 0,
        deleted_file_count: 4
      }
    }),
    published_delivery_entries: [],
    event_type: 'scheduled',
    target_branch: 'main'
  })

  assert.doesNotMatch(body, /Deletion review skipped/)
  assert.match(body, /Deleted files in window: `4`/)
})
