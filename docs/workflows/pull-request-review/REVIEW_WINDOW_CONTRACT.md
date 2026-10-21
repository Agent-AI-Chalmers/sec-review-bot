# Pull Request Review Window Contract

Language: English | [中文](REVIEW_WINDOW_CONTRACT.zh.md)

## Problem

A pull request review run materializes three artifacts that all describe the same change:

- `changed-files.json`, the file list for the window;
- `incremental.patch`, the diff of that window;
- the input's `files` collection, the separate export that anchors inline suggestions and mitigation patches.

If those three describe different change windows, the run is internally inconsistent.

### How an agent learns the window

An agent reads the window through git in the workspace, using the run's own range boundaries, and keeps only findings tied to what changed there. Git holds both ends of the window, so it answers the same question the patch does, while letting an agent read the part of a change it needs rather than a whole rendered diff: a small change takes one command, and a large change cannot be read end to end.

### Why the artifacts stay

`changed-files.json` and `incremental.patch` are a stable record of what a run reviewed, readable without reconstructing the window from repository state. That is a property of the run, not of any consumer, so it holds regardless of what an agent is told to read.

Suggestion anchoring is a separate concern and uses the input's `files` collection, which input preparation exports alongside the patch.

This document records the window semantics, the measured behavior of the GitHub APIs involved, what the review tooling ecosystem does, and the contract this project adopts.

## Two Windows

For a given run there are exactly two candidate windows:

| Window | Range | Meaning |
| --- | --- | --- |
| Full PR | `base_sha...head_sha` | Everything the pull request introduces relative to the merge base. |
| Push | `previous_head_sha..head_sha` | Only the commits added by the `synchronize` event that triggered this run. |

`previous_head_sha` comes from the [`before` field of the `pull_request` webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request). The `synchronize` payload type requires both `after` and `before`, as pinned in this repository's `@octokit/openapi-webhooks-types` dependency:

```ts
"webhook-pull-request-synchronize": {
  action: "synchronize";
  after: string;
  before: string;
  ...
}
```

That type is the only normative statement available. The webhook documentation says nothing about what `before` means when the branch was force-pushed, and the [compare endpoint](https://docs.github.com/en/rest/commits/commits#compare-two-commits) documents its own `basehead` parameter but not the reachability of the commits behind it.

## Measured API Behavior

These behaviors were verified against the live API rather than inferred from documentation.

### The full-PR window must use a three-dot range

GitHub reports `pull_request.base.sha` as the **current tip of the base branch**, not the point where the branch forked. Measured: four different open pull requests on `apache/hbase` all returned the same `base.sha` (`09474ab7...`), which is the `master` tip.

Consequently the base and head commits can be on diverged histories. A two-dot diff (`base..head`) compares the two trees, so work that landed on the base branch after the fork renders as if the pull request deleted it. A three-dot diff (`base...head`) diffs from the merge base and matches the pull request's actual change set. This is the same semantics as the [GitHub compare endpoint](https://docs.github.com/en/rest/commits/commits#compare-two-commits), whose `basehead` parameter is documented as `BASE...HEAD`.

A three-dot diff requires a merge base, so the workspace must not be shallow. Multi-ref materialization fetches without `--depth` for this reason.

### Fetching by SHA leaves commits unreachable

Fetching a specific commit SHA creates no branch or tag pointing at it. The existing workspace sanitize step prunes unreachable objects (`reflog expire --expire=now --all` followed by `gc --prune=now`), which deleted the base commit and made the comparison fail with `fatal: Invalid symmetric difference expression`. Fetched commits are now pinned under `refs/sec-review/base` and `refs/sec-review/head` before sanitizing, named for their role in the review window. `head` is the last requested ref; `base` is whichever ref matches the caller's explicit `window_base_sha`. A pull request passes its own base before the window base, and on `synchronize` those are different commits, so the first ref is pinned as `pinned-N` rather than assumed to be the window start.

### The files API omits `patch` on large pull requests

The [`GET /repos/{owner}/{repo}/pulls/{number}/files`](https://docs.github.com/en/rest/pulls/pulls#list-files-for-a-pull-request) endpoint returns every changed path but leaves `patch` empty for part of a large pull request. Measured on `apache/hbase` #7722: 340 files returned, 93 without a patch, including the largest ones. The documented response cap is 3000 files.

Building the patch from that field therefore drops changes silently. The patch is now exported from the workspace repository instead, which yields all 340 files for the same pull request.

### Compare against an unreachable base fails, it does not return empty

[`GET /repos/{owner}/{repo}/compare/{basehead}`](https://docs.github.com/en/rest/commits/commits#compare-two-commits) behaves differently for the two situations that matter:

| Situation | Response |
| --- | --- |
| Identical commits, empty diff | `200`, `files: []`, `status: identical` |
| Unreachable base commit | `404 Not Found` |

`synchronize` uses `previous_head_sha...current_head_sha`, which needs the historical head to still be reachable. The current code does not guard this call, so a 404 propagates and fails the whole preparation instead of falling back to the full pull request. The fallback that was intended (`incrementalFiles.length > 0`, otherwise re-read all files) only covers the empty-diff case.

This is a latent defect independent of force-push: it triggers whenever the historical head is no longer resolvable. It is not established that force-push reliably produces that state, because GitHub does not document how long a force-pushed commit stays resolvable.

## What Other Review Tools Do

### CodeRabbit

The documentation states an explicit two-mode policy, quoted from [Pull Request Reviews](https://docs.coderabbit.ai/overview/pull-request-review.md):

> **New PRs**: Full analysis of all changes with detailed findings
> **New commits**: Incremental reviews that track what's new since the last review
> **Every update**: Fresh insights without repeating resolved comments

### PR-Agent (open source, source inspected)

[`pr_agent/servers/github_app.py`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/servers/github_app.py):

- a `synchronize` event routes to `handle_push_trigger_for_new_commits`, which runs `push_commands`; the default is `['/describe', '/review']`, so the default `synchronize` behavior is a **full** re-review, not an incremental one;
- the incremental path is opt-in via the `-i` flag (`IncrementalPR`), and is gated. [`pr_reviewer.py`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/tools/pr_reviewer.py) falls back to a full review when there is no previous review, or when no commit predates the previous review;
- the reason given in [`github_provider.py`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/git_providers/github_provider.py) is explicit: "Every commit post-dates the review (e.g. the branch was fully rebased), so there is no baseline commit to diff against. Fall back to a full review rather than diffing against a None ref, which silently yields empty original content."
- the same file skips merge commits and tracks unreviewed files in `unreviewed_files_map`.

The structural lesson is the one this document argues for: PR-Agent derives the file set, the diff, and the prompt scope from a **single** window. It never has one artifact on the full window and another on the push window.

### Community assessment of incremental review

[Anantys-oss/koan#666](https://github.com/Anantys-oss/koan/issues/666) summarizes the tradeoff from a PR-Agent analysis:

> **Pros**: Saves significant quota on iterative PR workflows; avoids repeating previous feedback; faster review cycles
>
> **Cons**: Requires tracking last-reviewed commit per PR; **delta diffs can miss context from earlier changes**; more complex state management

## Candidate Contracts

The audit that motivated this document framed the choice as two contracts. They are not symmetric in this project.

| | Full revision on `synchronize` | Incremental revision on `synchronize` |
| --- | --- | --- |
| Window | all three artifacts on `base...head` | all three artifacts on `previous..head` |
| Cost | repeats full analysis on every push | bounded by push size |
| Repeated findings | likely, across runs | unlikely |
| Cross-file causality | preserved | **can be missed** when a push changes shared code |
| `changed-files.json` semantics | matches the patch | matches the patch |

The decisive requirement is not which window is better; it is that **whatever window is chosen, all three artifacts share it**.

## Contract This Project Adopts

`synchronize` uses the **push window** for all three artifacts. The reasons:

- the event already carries the window, and the audit identified it as the intended scope;
- it matches CodeRabbit's documented behavior for new commits;
- full re-review on every push scales linearly with pull request size, which interacts badly with the large-pull-request cost measured in this repository (a real 340-file pull request is a 7.6 MB diff);
- the analyzer can still read `/workspace` for cross-file context; only the **reported scope** is narrowed.

The window is resolved **once** and threaded through, rather than being decided independently by each artifact. A single function decides the window and produces the file list, the patch range, and the suggestion file set together.

Two guards accompany the contract:

1. **Fall back to the full window** when the push window cannot be established: `previous_head_sha` missing, the compare call returning an empty change set, or the compare call failing with `404`. This is the guard that does not exist today and that the measured 404 behavior requires.
2. **Never mix windows.** A run whose file list comes from one window and whose patch comes from another is rejected rather than published, because the resulting analyzer instructions contradict each other and the suggestion anchoring silently drops changes.

3. **Fall back to the full window when the push window is not a fast-forward.** The compare response reports commits on both sides (`behind_by`) when the previous head is not an ancestor of the current head, which is what a force-push leaves behind. Such a window no longer describes an incremental change, and the workspace cannot even contain the discarded head, so the run covers the whole pull request instead.

The ancestry check reads a field the compare response already returns, so it costs no extra request. GitHub still does not document how long a force-pushed commit stays resolvable, which is why the 404 fallback above remains necessary rather than redundant.
