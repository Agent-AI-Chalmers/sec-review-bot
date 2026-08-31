# Repository Incremental Review Strategy

Language: English | [中文](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.zh.md)

In repository-level scheduled runs, such as weekly `schedule`, always running a full scan causes cost and latency to grow over time. This requires an incremental mode.

## Core Semantics

Incremental security scan can be viewed as a large PR review over the "final merged result": the change set within the `base..head` time window.

- Primary evidence surface: code and configuration changes themselves (`diff` + `changed files`).
- Auxiliary evidence surface: commit titles and messages, used only for intent calibration and false-positive disambiguation.
- Reuses the repository-review workflow.

## Mode Definition

Scan mode has two values:

- `full`: repository-level full scan, the existing behavior.
- `incremental`: incremental scan based on `base..head`.

Dispatch payload introduces:

- `scan_mode`: `"full" | "incremental"`
- `base_sha`: string, incremental window start commit boundary
- `target_branch`: string, required branch/ref label selected by the caller
- `head_sha`: string, optional, defaults to the current commit of `target_branch`

When `scan_mode=incremental`:

- `head_sha = resolve(head_sha || target_branch)`
- `base_sha` is a required boundary and does not use candidate-priority fallback.
- In scheduled mode, `base_sha` has fixed semantics: the boundary commit derived by looking back over the time window.
- If `base_sha` is missing, unreachable, or invalid, fail directly with an explicit error.

## Materialization Design

### Directories And Artifacts

Compared with full scan, incremental scan adds these artifacts:

- `incremental-window/incremental.patch`: unified diff for `base_sha..head_sha`
- `incremental-window/changed-files.json`: structured changed-file list, including status, rename, size, and similar metadata
- `history/scan-window.json`: incremental window metadata, including base/head, trigger source, and time
- `history/commits.json`: commit summaries for `base_sha..head_sha`

Minimum `changed-files.json` shape:

```json
{
  "base_sha": "abc123",
  "head_sha": "def456",
  "files": [
    {
      "path": "src/app.ts",
      "status": "modified",
      "previous_path": null
    }
  ]
}
```

Minimum `history/commits.json` shape:

```json
{
  "base_sha": "abc123",
  "head_sha": "def456",
  "commits": [
    {
      "sha": "111aaa",
      "title": "fix(auth): tighten JWT audience check",
      "author": "alice",
      "committed_at": "2026-04-19T08:01:02Z"
    }
  ]
}
```

### Role of `history` as Auxiliary Evidence

`history` is an auxiliary evidence layer for analysis. `/workspace` and `/incremental-window` are the primary evidence surfaces.

Constraints:

- `history` can strengthen conclusions, but cannot establish a vulnerability by itself.
- In `incremental` mode, both `history` and `diffs` are required artifacts; missing artifacts fail the run.
- Reports that cite `history` should mark it as an auxiliary context source.

## Discovery Strategy Adjustment

### Scan Scope

When `scan_mode=incremental`, discovery scans only:

- added/modified files in `changed-files.json`;
- deleted files are not scanned, but are preserved as context metadata;
- renamed files are scanned at the new path, while preserving old-path mapping.

### Relationship With `paths_ignore`

Repository `paths_ignore` configuration is still honored.

The incremental window's `changed_file_count` is written to `history/scan-window.json`. The actual number of files entering discovery is still expressed through discovery summary fields `scannable_file_count`, `scanned_file_count`, `skipped_file_count`, and `candidate_count`, which explain why an incremental run produced almost no findings.

## Scheduling Recommendation

Recommended combination:

- run `incremental` frequently, such as daily or weekly
- run `full` infrequently, such as monthly

Reasons:

- incremental scans control cost and provide fast feedback;
- full scans cover cross-window latent issues and historical blind spots.

### Scheduled vs Manual Window Semantics

- `schedule` (scheduled incremental):
  - the caller sends `target_branch` and the cron `schedule` to the GitHub integration HTTP dispatch endpoint;
  - the App dispatch resolver resolves `head_sha` from `target_branch`;
  - the App dispatch resolver computes `base_sha` by looking back roughly one schedule interval and selecting the latest commit before that cutoff;
  - actual scan window is `base_sha..head_sha`.
- `manual` (manual incremental):
  - caller must explicitly specify `base_sha`; `head_sha` may be omitted;
  - does not depend on automatic time lookback;
  - suitable for targeted replay, backfill scans, and comparison analysis.

## Failure Policy: No Downgrade

Incremental mode uses a hard-failure policy:

- an `incremental` request must not automatically fall back to `full`
- silent failure followed by "success with empty result" is not allowed

The following cases fail directly, without downgrading to `full`:

- no available `base_sha`;
- `base_sha` is not reachable in the current repository history;
- diff generation fails or the change range is abnormal, such as a huge rewrite.

Failure reasons must be written explicitly to error logs and job results to avoid semantic drift where the request was incremental but execution actually ran full scan.

Why `incremental -> full` is forbidden:

- Falling back from incremental to full changes scan semantics and result scope, causing request/execution mismatch.
- That mismatch is risky in a security context: it can look like incremental review completed while a different evaluation boundary was executed.
- Therefore, the system chooses explicit failure over implicit downgrade, surfacing semantic errors to callers and scheduling systems early.
