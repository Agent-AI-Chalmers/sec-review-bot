# Memory Catalog API

Language: English | [中文](README.zh.md)

[v1/openapi.yaml](v1/openapi.yaml) is the hand-maintained single source of truth for the Memory Catalog Server HTTP boundary. The server mounts routes and validation from it, generated TypeScript projections bind both the server and Control Plane UI to its operations and schemas, and Python client contract tests validate the payloads and responses they consume.

Extraction and observation collection reads use opaque, exclusive cursors with deterministic newest-first ordering. Callers must pass the same filters while advancing `next_cursor`; cursor encoding is an implementation detail. Revision history retains its public, exclusive `before_revision` cursor because revision numbers are already immutable monotonic identities.

`GET /v1/overview` aggregates completed extraction coverage directly from Catalog state. A unit is the `(source_run_id, source_unit_id)` pair. A unit without an observation has at least one completed extraction and no completed extraction that produced an observation; failed or unfinished extractor executions are outside this Catalog view. The `range` query selects a 30-day, 90-day, or all-time trend. `trend_points` uses the declared `trend_granularity`: the 30-day and 90-day ranges use daily points, while all-time uses monthly points. Each point's `period_start` is the inclusive UTC start date of its represented day or month.

Memory revisions use a tagged `source`: `learning` carries an `operation_id`, consumed extraction IDs, and a `trajectory_reference`; `reorganization` carries an `operation_id` and `trajectory_reference` but consumes no observations; `manual` requests carry an idempotent `operation_id`, while stored revisions add the actor derived from the authenticated operator credential. `operation_id` uniquely identifies a revision operation across all source kinds; reusing it with a different kind conflicts. Every revision records the revision that was active as its `predecessor_revision`. Restore is a separate idempotent operation that compare-and-swaps the active pointer to an existing revision without creating a revision.

Worker credentials register extractions, read learning input, and submit learning or reorganization revisions. Operator credentials pause or resume memory-tree automation and submit manual revisions or restores. Shared catalog reads accept either credential, and revision creation rejects a source kind that does not match the authenticated role.

`GET /v1/memory-tree/automation` exposes the `enabled` or `paused` admission state for new `learning` and `reorganization` revision commits. Pausing rejects those commits with HTTP 409 and `AUTOMATION_PAUSED`; it does not cancel running work or block artifact publication, extraction registration, `manual` revisions, restores, or identical replays of successful commits. The `/pause` and `/resume` actions use an idempotent `operation_id` and `expected_generation` compare-and-swap. Their responses contain `created` and an `automation` snapshot. An identical replay returns the original resulting snapshot even if current state has since changed.

To publish an extraction result or memory revision, first reserve a publication intent containing the complete result and artifact references. After uploading the objects, the uploader confirms that they exist. This confirmation is the uploader's assertion, not a Catalog check of object storage. When registering the result, Catalog requires an exact match with a confirmed publication intent and completes registration and intent selection in the same transaction.

After an interrupted publication, callers can query recorded intents for retries. Catalog retains these records but does not automatically complete interrupted publications or clean up the associated objects.

Workers can abandon existing unselected `learning` or `reorganization` publications through `POST /v1/memory-tree/revisions/publications/abandon`. These publications become `abandoned`; retries do not restore them, and committing them returns HTTP 409 with `PUBLICATION_ABANDONED`. A new automatic commit rejected while paused atomically abandons the existing unselected publications for its source kind and operation ID. Maintenance workflows abandon these publications when preparation observes a pause and exit normally without backlog continuation on pause or abandonment. Selected publications and shared artifact objects are retained.

## Tooling

Run from `tools/`:

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```
