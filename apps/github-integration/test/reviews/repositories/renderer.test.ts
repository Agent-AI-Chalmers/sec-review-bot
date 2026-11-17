import { expect, test } from 'vitest'

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
      target_claim: null,
      validation_level: null,
      coverage: null,
      regression: null,
      next_step: null,
      findings: [],
      evidence: [],
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
    triaged_case_count: 0,
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
    case_count: case_results.length,
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
      coverage: 'partial',
      regression: 'not-run',
      validation_level: 'static',
      next_step: 'manual-review',
      overview: 'Queued retry payloads remain unverified.'
    }
  })
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView(
      [
        {
          case_id: 'case-1',
          deliverable: false,
          reason: 'The verifier did not fully approve the patch.',
          review_record
        }
      ],
      {
        scan_summary: {
          scannable_file_count: 1,
          scanned_file_count: 1,
          triaged_case_count: 1,
          suppressed_candidate_count: 0
        }
      }
    ),
    published_delivery_entries: [],
    event_type: 'manual',
    target_branch: 'main'
  })

  expect(body).toMatch(/Blocked confirmed cases: `1`/)
  expect(body).toMatch(/### Blocked Confirmed Cases/)
  expect(body).toMatch(/<summary>\[medium\] case-1/)
  expect(body).toMatch(/<summary>Analysis<\/summary>/)
  expect(body).toMatch(/<summary>CVSS<\/summary>/)
  expect(body).toMatch(/<summary>Mitigation<\/summary>/)
  expect(body).toMatch(/<summary>Reference patch<\/summary>/)
  expect(body).toMatch(/```diff\n(?:.|\n)*verifyRetrySignature/)
  expect(body).toMatch(/<summary>Verification<\/summary>/)
  expect.assert(
    body.indexOf('<summary>Analysis</summary>') <
      body.indexOf('<summary>CVSS</summary>')
  )
  expect.assert(
    body.indexOf('<summary>CVSS</summary>') <
      body.indexOf('<summary>Mitigation</summary>')
  )
  expect.assert(
    body.indexOf('<summary>Mitigation</summary>') <
      body.indexOf('<summary>Verification</summary>')
  )

  // The card reuses the shared status vocabulary instead of restating it, and the
  // title carries case identity rather than repeating the coverage rating.
  expect.assert(
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
  expect.assert(titleLine)
  expect.assert(
    !titleLine.includes(coverageHeadline(review_record.verification.coverage))
  )
})

test('repository blocked confirmed case uses deliverable reason as mitigation and verification fallback', () => {
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([
      {
        case_id: 'case-1',
        deliverable: false,
        reason: 'Verifier rejected the incomplete patch.',
        review_record: reviewRecord({
          analysis: {
            verdict: 'confirmed-vulnerability',
            overview: 'Signed webhook retries can be replayed.'
          },
          verification: {
            coverage: 'partial',
            regression: 'not-run',
            validation_level: 'static'
          }
        })
      }
    ]),
    published_delivery_entries: [],
    event_type: 'manual',
    target_branch: 'main'
  })

  expect(body).toMatch(
    /<summary>Mitigation<\/summary>\n\nVerifier rejected the incomplete patch\./
  )
  expect(body).toMatch(
    /<summary>Verification<\/summary>\n\nVerifier rejected the incomplete patch\./
  )
  expect(body).not.toMatch(/No mitigation overview was recorded\./)
  expect(body).not.toMatch(/No verification overview was recorded\./)
})

test('repository renderer preserves CVSS not-scored state', () => {
  const summary = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([
      {
        case_id: 'case-1',
        deliverable: true,
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
        deliverable: true,
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

  expect(summary).toMatch(/CVSS scored cases: `1`/)
  expect(summary).toMatch(/CVSS not-scored cases: `1`/)
  expect(summary).toMatch(/Case CVSS severities: `critical=0`, `high=1`/)
  expect(summary).toMatch(
    /Grouped by each delivery PR's highest case CVSS severity\./
  )
  expect(summary).toMatch(/#### not-scored \(1\)/)
  expect(summary).toMatch(/\[CVSS not-scored\] \[sec\] container-runs-as-root/)
  expect(summary).not.toMatch(/\[CVSS 0\.0\]/)

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
        deliverable: true,
        reason: null,
        review_record: reviewRecord({
          cvss: {
            outcome: 'not-scored'
          }
        })
      }
    ]
  })

  expect(body).toMatch(/Outcome: `not-scored`/)
  expect(body).toMatch(/## Case Details/)
  expect(body).not.toMatch(/#### Case Summary/)
  expect(body).not.toMatch(/Verdict: `confirmed-defect`/)
  expect(body).not.toMatch(/Affected paths:/)
  expect(body).not.toMatch(/##### Evidence anchors/)
  expect(body).not.toMatch(/Coverage: `full`/)
  expect(body).not.toMatch(/Next step: `none`/)
  expect(body).not.toMatch(/Case deliverable:/)
  expect(body).not.toMatch(/- Analysis: `confirmed security defect`/)
  expect(body).not.toMatch(/## Delivery CVSS/)
  expect(body).toMatch(/<summary>CVSS<\/summary>/)
  expect(body).not.toMatch(/<!-- case-level mitigation overview -->/)
  expect(body).not.toMatch(/#### Mitigation notes/)
  expect(body).not.toMatch(/- Outcome: `patched`/)
  expect(body).not.toMatch(/Reviewer-visible concern\./)
  expect(body).not.toMatch(/##### Residual risks/)
  expect(body).not.toMatch(/^#### Evidence$/m)
  expect(body).not.toMatch(/#### Analyzer Result/)
  expect(body).not.toMatch(/#### CVSS Scoring/)
  expect(body).not.toMatch(/<summary>Audit metadata<\/summary>/)
  expect(body).not.toMatch(
    /This is hardening, not an independent vulnerability\./
  )
  expect(body).not.toMatch(/CVSS v4 base score: `n\/a` \(`unknown`\)/)
  expect(body).not.toMatch(/Target claim: \(none\)/)
})

test('repository summary workflow view projects a validated repository result without reparsing', () => {
  const caseResult: RepositoryCaseResult = {
    case_id: 'case-1',
    deliverable: true,
    reason: null,
    review_record: reviewRecord()
  }
  const view = buildRepositorySummaryWorkflowView(
    repositoryResult([caseResult], { scan_summary: { triaged_case_count: 1 } }),
    { run_id: 'run-1' }
  )

  expect(view).toStrictEqual({
    run_id: 'run-1',
    case_count: 1,
    deletion_review_skipped: false,
    scan_summary: {
      scannable_file_count: 0,
      scanned_file_count: 0,
      skipped_file_count: 0,
      candidate_count: 0,
      triaged_case_count: 1,
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

  expect(body).toMatch(/## Modified Files/)
  expect(body).toMatch(/- `src\/server\.js`/)
  expect(body).not.toMatch(/Removed sensitive health metadata/)
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
        deliverable: true,
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
            coverage: 'full',
            regression: 'not-run',
            next_step: 'none',
            validation_level: 'static',
            findings: ['Reviewer-visible concern.'],
            evidence: []
          }
        })
      }
    ]
  })

  expect(body).toMatch(/## Case Details/)
  expect(body).toMatch(/<summary>View case case-1<\/summary>/)
  expect(body).toMatch(/- Analysis: `confirmed security defect`/)
  expect(body).toMatch(/<summary>Analysis<\/summary>/)
  expect(body).toMatch(/<summary>CVSS<\/summary>/)
  expect(body).toMatch(/<summary>Mitigation<\/summary>/)
  expect(body).toMatch(/<summary>Verification<\/summary>/)
  expect(body).toMatch(/Restrict preview root\./)
  expect(body).toMatch(/Reviewer-visible concern\./)
  expect(body).not.toMatch(/delivery\.cases/)
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
        deliverable: true,
        reason: null,
        review_record: reviewRecord({
          analysis: {
            verdict: 'confirmed-defect',
            overview: 'Preview endpoint exposed repository files.'
          },
          verification: {
            coverage: 'full',
            regression: 'not-run',
            validation_level: 'static'
          }
        })
      }
    ]
  })

  expect(body).toMatch(
    /<summary>Mitigation<\/summary>\n\nNo mitigation overview was recorded\./
  )
  expect(body).toMatch(
    /<summary>Verification<\/summary>\n\nNo verification overview was recorded\./
  )
  expect(body).not.toMatch(/Verifier rejected the incomplete patch\./)
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

  expect(body).toMatch(/### Coordination Notes/)
  expect(body).toMatch(/Shared modified file `src\/server\.js`/)
  expect(body).toMatch(/\[`case-1`\]\(https:\/\/example\.test\/pull\/1\)/)
  expect(body).toMatch(/\[`case-2`\]\(https:\/\/example\.test\/pull\/2\)/)
  expect(body).toMatch(
    /These delivery PRs touch the same file; review publish order if publishing them together\./
  )
  expect(body).not.toMatch(/Shared modified file `Dockerfile`/)
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
        triaged_case_count: 0,
        suppressed_candidate_count: 0,
        deleted_file_count: 250
      }
    }),
    published_delivery_entries: [],
    event_type: 'scheduled',
    target_branch: 'main'
  })

  expect(body).toMatch(/Deletion review skipped/)
  expect(body).toMatch(/`250` files/)
  // The warning sits above the summary details, so skimming the top of the comment shows it.
  expect.assert(
    body.indexOf('Deletion review skipped') <
      body.indexOf('Review summary details')
  )
  expect(body).toMatch(/Deleted files in window: `250`/)
})

test('repository renderer stays quiet when deletion review ran', () => {
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: summaryView([], {
      deletion_review_skipped: false,
      scan_summary: {
        scannable_file_count: 3,
        scanned_file_count: 3,
        triaged_case_count: 0,
        suppressed_candidate_count: 0,
        deleted_file_count: 4
      }
    }),
    published_delivery_entries: [],
    event_type: 'scheduled',
    target_branch: 'main'
  })

  expect(body).not.toMatch(/Deletion review skipped/)
  expect(body).toMatch(/Deleted files in window: `4`/)
})

test('repository summary distinguishes triage, reviewed and delivery-ready case counts', () => {
  const cases: RepositoryCaseResult[] = [
    {
      case_id: 'triage-case',
      deliverable: true,
      reason: null,
      review_record: reviewRecord()
    },
    {
      case_id: 'deletion-case',
      deliverable: false,
      reason: 'Analyzer failed.',
      review_record: reviewRecord()
    }
  ]
  const result = repositoryResult(cases, {
    scan_summary: { triaged_case_count: 1, deleted_file_count: 3 }
  })
  const view = buildRepositorySummaryWorkflowView(result, { run_id: 'counts' })
  expect(view.case_count).toBe(2)
  expect(view.scan_summary.triaged_case_count).toBe(1)
  const body = renderRepositorySecuritySummaryComment({
    workflow_result: view,
    published_delivery_entries: [],
    event_type: 'manual',
    target_branch: 'main'
  })
  expect(body).toMatch(/Reviewed cases: .2./)
  expect(body).toMatch(/Cases after triage: .1./)
  expect(body).toMatch(/Deleted files in window: .3./)
  expect(body).toMatch(/Ready for delivery: .1./)
})
