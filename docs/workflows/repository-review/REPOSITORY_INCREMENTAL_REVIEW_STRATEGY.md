# Repository Incremental Review Strategy

Language: English | [中文](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.zh.md)

In repository-level scheduled runs, such as weekly `schedule`, always running a full scan causes cost and latency to grow over time. This requires an incremental mode.

## Design Rationale

A time window gives us `base` and `head`. Between them sit many commits, and comparing the two ends yields files that were modified, added, deleted, or renamed.

Does discovery need to read all of that change in order to find vulnerabilities? No, for one reason:

> A change that introduces a problem leaves that problem in the current code. Once it is there, it no longer depends on the change.

So the change is used for one thing: finding out which files were modified. Those files become the scan targets, and scanning them is what makes this cheaper than a full scan. The current code is the evidence surface; the window only decides where to look.

That leaves one placement question: where does the window judgement live? In the analyzer. Discovery makes a single-file judgement and reports what a file currently looks like; it cannot see the window, so it does not try to. The analyzer already holds the diff and the rest of the context, so judging whether a lead is true and whether it belongs to this window costs about the same. A finding that is real but pre-existing is identified there and dropped for this run.

Putting window attribution in analyzer rather than discovery is a deliberate cost trade-off. Giving discovery its own change-aware mode would mean a second discovery pipeline with its own prompts and candidate handling, which is expensive for what it buys.

This route has one blind spot it cannot close by itself.

### Deletion

Removing a protection does not leave the problem on a line of current code; it leaves the problem as an absence. An absence has no line to look at, and discovery only judges what a file currently contains, so it cannot read that a check used to be there and is gone.

That produces a stable class of misses:

- A unified authentication middleware is deleted while every route file is untouched. The routes never held the auth logic — the middleware did — so in current code they look exactly as they did yesterday.
- A shared validation function is deleted while its call sites are unchanged. The call sites still call it; no line of them looks unsafe.
- A denylist, certificate, or policy file is deleted while the code it governed is unchanged.

What these have in common is that **the affected code was not modified**. The rule above does not reach them, because what the change introduced is the absence of a protection.

The fix is to turn deleted files into cases directly. Deleted files skip discovery and skip triage. Deletions are grouped by nearest parent directory, one analyzer case per directory, alongside the regular ones:

- existing changed files: `discovery -> triage -> analyzer`;
- deleted files: a deletion case is generated deterministically and goes straight to the analyzer;
- the analyzer receives both and decides uniformly whether any case is a real finding.

It is cheap: no model decides which cases exist, and no discovery or candidate logic changes. A deletion belongs to this window by construction, so no second scope judgement is needed.

The boundary is the directory, not a count, because a directory is a boundary the repository itself drew: files removed together from one place usually belong to one mechanism -- a middleware and the policy beside it -- and analysing them separately makes the analyzer re-read the same callers per file while hiding that they went together. Slicing by a fixed number would instead assert a relevance nothing supports.

The boundary is imperfect: a broad directory such as `src/`, `config/`, or the repository root can hold several independent mechanisms.

A single cap on the number of deleted files (200) therefore decides whether deletion review happens at all. Past the cap the whole window's deletion review is skipped: it is not split, and directories are not picked over one by one. Splitting would make the result look reviewed, and picking would produce a partial result that reads as complete. The caller chose the window, so an oversized one is the caller's to narrow, and the answer is one they can act on rather than a result they have to audit.

The skip does not affect anything else: ordinary triaged cases still run. Two fields in the result report it: `scan_summary.deleted_file_count` is how many files the window removed, and `deletion_review_skipped` says whether review was skipped because of that. The count sits in the scan summary because it explains a thin incremental run: deleted files never reach discovery.

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

The commit identities for the window travel in `scan_target.commit_shas`, as they do for pull request runs. Commit messages and authorship are not materialized: the patch already shows what changed, and a message is author-supplied text that adds nothing a security review can act on.

### Role of `history` as Auxiliary Evidence

`history` is an auxiliary evidence layer for analysis. `/workspace` and `/incremental-window` are the primary evidence surfaces.

Constraints:

- `history` can strengthen conclusions, but cannot establish a vulnerability by itself.
- In `incremental` mode, both `history` and `diffs` are required artifacts; missing artifacts fail the run.
- Reports that cite `history` should mark it as an auxiliary context source.

## Discovery Strategy Adjustment

### Scan Scope

When `scan_mode=incremental`, discovery scans only:

- added, modified, renamed, copied, and type-changed files in `changed-files.json`;
- deleted files are not scanned: there is no current file to read. They are handled by deletion cases instead, described under Deletion above;
- renamed files are scanned at the new path, while preserving old-path mapping.

Discovery makes no window judgement. It receives whole files and reports what it finds in them, the same as in a full scan. Whether a lead belongs to this window is decided in analyzer.

### Relationship With `paths_ignore`

Repository `paths_ignore` configuration is still honored, for both discovery's file selection and deletion cases. A deleted path matching `paths_ignore` produces no case, so deleting an ignored tree keeps it out of review entirely.

The incremental window's `changed_file_count` is written to `history/scan-window.json`. The actual number of files entering discovery is still expressed through discovery summary fields `scannable_file_count`, `scanned_file_count`, `skipped_file_count`, and `candidate_count`, which explain why an incremental run produced almost no findings.

## Scheduling Recommendation

Recommended combination:

- run `incremental` frequently, such as daily or weekly
- run `full` infrequently, such as monthly

Reasons:

- incremental scans control cost and provide fast feedback;
- full scans cover files that no window ever selected, and build the historical picture incremental runs deliberately skip.

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