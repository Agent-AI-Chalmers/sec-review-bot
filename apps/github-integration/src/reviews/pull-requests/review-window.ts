import type { PullRequestFile } from '../../github/pull-request-service.js'

/**
 * The change window a review run is scoped to.
 *
 * Every artifact of a run -- `changed-files.json`, `incremental.patch`, and the
 * suggestion anchoring file set -- must share one window. Two artifacts on
 * different windows make the analyzer instructions self-contradictory: the
 * prompt asks for causality derived from the patch and the changed-file list
 * together, and the suggestion anchoring silently drops any file outside the
 * file set. See docs/workflows/pull-request-review/REVIEW_WINDOW_CONTRACT.md.
 */
export interface ReviewWindow {
  /** Only the kind and range are used to build artifacts. */
  kind: 'full' | 'push'
  /** Exclusive start of the comparison. */
  base_sha: string
  /** Inclusive end of the comparison. */
  head_sha: string
  /**
   * Why this window was chosen. Recorded so a run that silently degrades from a
   * push window to a full window can be identified from its logs. This is not a
   * user-facing string; it names a condition.
   */
  reason:
    | 'pull-request-scope'
    | 'synchronize-scope'
    | 'synchronize-previous-head-missing'
    | 'synchronize-previous-head-unreachable'
    | 'synchronize-no-files-changed'
}

export interface ResolvedReviewWindow {
  /** The window every artifact of this run must use. */
  window: ReviewWindow
  files: PullRequestFile[]
}

export function fullReviewWindow(pr: {
  base_sha: string
  head_sha: string
}): ReviewWindow {
  return {
    kind: 'full',
    base_sha: pr.base_sha,
    head_sha: pr.head_sha,
    reason: 'pull-request-scope'
  }
}

export function pushReviewWindow(pr: {
  previous_head_sha: string
  head_sha: string
}): ReviewWindow {
  return {
    kind: 'push',
    base_sha: pr.previous_head_sha,
    head_sha: pr.head_sha,
    reason: 'synchronize-scope'
  }
}

/**
 * Resolve the window for an event and fetch its files.
 *
 * The GitHub compare endpoint answers `404` when the base commit is no longer
 * reachable, and `200` with an empty file list when the two commits are
 * identical. Only the second case means "nothing changed"; the first means the
 * push window cannot be established at all. Both fall back to the full pull
 * request window, for the reasons recorded in the contract document.
 *
 * The returned files and the returned window come from one decision, so a caller
 * cannot pair files from one window with a range from another.
 */
export async function resolveReviewWindowFiles({
  pr,
  event_type,
  list_push_window_files,
  list_full_window_files
}: {
  pr: { base_sha: string; head_sha: string; previous_head_sha: string | null }
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  list_push_window_files: (base_sha: string) => Promise<PullRequestFile[]>
  list_full_window_files: () => Promise<PullRequestFile[]>
}): Promise<ResolvedReviewWindow> {
  const full = (reason: ReviewWindow['reason']): ReviewWindow => ({
    ...fullReviewWindow(pr),
    reason
  })

  if (event_type !== 'synchronize') {
    return {
      window: full('pull-request-scope'),
      files: await list_full_window_files()
    }
  }
  const previous_head_sha = pr.previous_head_sha
  if (!previous_head_sha) {
    return {
      window: full('synchronize-previous-head-missing'),
      files: await list_full_window_files()
    }
  }

  let push_files: PullRequestFile[]
  try {
    push_files = await list_push_window_files(previous_head_sha)
  } catch {
    // An unreachable historical head is not an empty change set: the compare
    // endpoint reports it as 404. Answering the run with a full window keeps the
    // three artifacts consistent, which a partial or empty push window would not.
    return {
      window: full('synchronize-previous-head-unreachable'),
      files: await list_full_window_files()
    }
  }
  if (push_files.length === 0) {
    return {
      window: full('synchronize-no-files-changed'),
      files: await list_full_window_files()
    }
  }
  return {
    window: pushReviewWindow({ previous_head_sha, head_sha: pr.head_sha }),
    files: push_files
  }
}
