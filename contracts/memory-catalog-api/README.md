# Memory Catalog API

Language: English | [中文](README.zh.md)

[v1/openapi.yaml](v1/openapi.yaml) is the hand-maintained single source of truth for the Memory Catalog Server HTTP boundary. It is not generated from service code. The server mounts routes and validation from it, generated TypeScript projections bind both the server and Control Plane UI to its operations and schemas, and Python client contract tests validate the payloads and responses they consume.

The contract deliberately excludes PostgreSQL rows, Temporal workflow state, trajectory contents, and object-storage credentials.

Extraction and observation collection reads use opaque, exclusive cursors with deterministic newest-first ordering. Callers must pass the same filters while advancing `next_cursor`; cursor encoding is an implementation detail. Revision history retains its public, exclusive `before_revision` cursor because revision numbers are already immutable monotonic identities.

`GET /v1/overview` aggregates completed extraction coverage directly from Catalog state. A unit is the `(source_run_id, source_unit_id)` pair. A unit without an observation has at least one completed extraction and no completed extraction that produced an observation; failed or unfinished extractor executions are outside this Catalog view. The `range` query selects a 30-day, 90-day, or all-time trend. `trend_points` uses the declared `trend_granularity`: the 30-day and 90-day ranges use daily points, while all-time uses monthly points. Each point's `period_start` is the inclusive UTC start date of its represented day or month.

Memory revisions use a tagged `source`: `maintenance` carries the maintainer identity, consumed extraction IDs, and trajectory reference; `operator` carries an idempotent operation ID and authenticated actor. Every revision records the revision that was active as its `predecessor_revision`. Restore is a separate idempotent operation that compare-and-swaps the active pointer to an existing revision without creating a revision.

Maintenance control exposes only `enabled` and `paused`. Pause and resume requests use an idempotent `operation_id` and `expected_generation` compare-and-swap. An identical replay returns the original resulting control snapshot even if current state has since changed.

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
