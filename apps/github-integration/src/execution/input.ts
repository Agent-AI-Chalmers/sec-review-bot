import type {
  InputBundleArtifactRef,
  IssueReviewInput,
  PullRequestReviewInput,
  RepositoryReviewInput,
  RepositoryScanScope,
  RepositoryScanTarget,
  ReviewIntent
} from './execution-api-types-generated.js'

// GitHub integration prepared input shapes.
//
// The transport shapes are generated from `contracts/execution-api/v1/schemas`; this
// module re-exports them and adds the local vocabulary the integration needs. Do not restate a
// transport field here: a hand-maintained copy is how the producer and the schemas drifted apart
// before the projection existed.

// The limits are values, not types: a producer needs the bound before it builds the input.
export {
  MAX_PR_COMMIT_SHAS,
  MAX_SETUP_DECLARATION_TEXT,
  MAX_WORKFLOW_INPUT_BYTES,
  MAX_SCAN_SCOPE_INCREMENTAL_CHANGED_FILES,
  MAX_SCAN_TARGET_COMMIT_SHAS
} from './execution-api-types-generated.js'

export type {
  InputBundleArtifactRef,
  IssueReviewInput,
  PullRequestReviewInput,
  RepositoryReviewInput,
  RepositoryScanScope,
  RepositoryScanTarget,
  ReviewIntent
}

export type TestChangesPolicy = NonNullable<ReviewIntent['test_changes']>
export type ReviewObjective = ReviewIntent['objective']

/**
 * The pull request subject a `pull-request-review` run carries.
 *
 * `review_window` states the range the run covers. It is not derivable from `base_sha` and
 * `head_sha`, which identify the pull request itself and stay wider than the run on
 * `synchronize`.
 */
export type PullRequestReviewSubject = PullRequestReviewInput['pr']

/** The change range a run covers. */
export type ReviewWindowReference = PullRequestReviewSubject['review_window']

export const INPUT_BUNDLE_MEDIA_TYPE = 'application/tar+zstd' as const
