# Memory Catalog

Language: English | [中文](README.zh.md)

`services/memory-catalog/` exposes the HTTP API that records completed memory extractions, coordinates observation processing, and commits memory tree revisions. Coordination state is stored in PostgreSQL. Workers publish immutable memory trees and compressed memory-agent trajectories to object storage, and the catalog stores their artifact references.

## API

| Method | Path                                   | Purpose                                                                                                   |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                             | Report service health.                                                                                    |
| `POST` | `/v1/extractions`                      | Atomically register a completed extraction, its trajectory reference, and its optional observation.       |
| `GET`  | `/v1/extractions`                      | List completed extractions with stable cursor pagination and provenance filters.                          |
| `GET`  | `/v1/extractions/{extraction_id}`      | Return one extraction, its trajectory reference, and its optional observation.                            |
| `GET`  | `/v1/observations`                     | List observations with stable cursor pagination and consumption filters.                                  |
| `GET`  | `/v1/overview`                         | Summarize completed extraction coverage, observation outcomes, and a 30-day, 90-day, or all-time trend.   |
| `GET`  | `/v1/observation-backlog`              | Return the count and oldest age of pending observations.                                                  |
| `GET`  | `/v1/maintenance-control`              | Return the durable `enabled` or `paused` automatic-maintenance state.                                     |
| `POST` | `/v1/maintenance-control/pause`        | Idempotently pause automatic maintenance with generation compare-and-swap.                                |
| `POST` | `/v1/maintenance-control/resume`       | Idempotently resume automatic maintenance with generation compare-and-swap.                               |
| `GET`  | `/v1/maintenance-input?limit=...`      | Return up to `limit` observations and the active memory state they must be maintained against.            |
| `POST` | `/v1/memory-tree/revisions`            | Create a maintenance or operator revision with idempotency and expected-active-revision compare-and-swap. |
| `GET`  | `/v1/memory-tree`                      | Return the current memory tree and its revision.                                                          |
| `POST` | `/v1/memory-tree/restore`              | Move the active pointer to an existing revision without creating a revision.                              |
| `GET`  | `/v1/memory-tree/revisions`            | List memory tree revision history.                                                                        |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | Return one memory tree revision, its maintenance identity, and its artifact references.                   |

The service owns its PostgreSQL database and its `schema_versions` ledger. The default integrated deployment places that database beside, but separate from, Review Runs database in the same PostgreSQL instance.

Collection cursors are opaque and exclusive. Extractions and observations are ordered by `created_at` and then `extraction_id`, both descending, so records with equal timestamps remain stable across pages. The maintenance-control row is durable and initially records `enabled` with generation `0`; the API returns its current state and changes it through the pause and resume operations.

Only one maintainer may execute at a time. Temporal enforces that invariant with one fixed workflow ID and a schedule overlap policy of `SKIP`; the catalog therefore does not implement batch leases or concurrent claims.

Before uploading, producers reserve complete extraction or revision publication intents through the publication endpoints. An extraction publication intent includes its observation and summary; a maintenance publication intent keeps the tree, trajectory, observation IDs, and expected active revision together. Producers confirm only after all objects are present. Registration and revision creation require a matching confirmed publication intent and select it in the same transaction as the authoritative records. Different model attempts may reserve different digest candidates, but each logical owner has at most one selected publication intent.

Preparation retries list recorded publication intents and verify immutable S3 metadata before rerunning a model. Storage errors remain uncertain and stop recovery; definite absence permits a new candidate unless the publication intent is already selected. Candidates remain recorded after CAS/pause conflicts or partial uploads; this protocol does not delete unreferenced objects or provide automatic background completion after retries are exhausted. The UI BFF can reconstruct an operator publication intent from the same edit request and retries its immutable upload. The browser retains the operation ID and original expected revision for retries of unchanged content within the open editor.

Temporal also records the prepared result before dispatching the registration or revision commit activity, so commit retries reuse the same payload.

Revision provenance is a tagged maintenance/operator source. Every revision records the active revision from which it was created as `predecessor_revision`; revision numbers remain globally increasing even after the active pointer moves backward. Operator `operation_id` values are unique: identical replays return the original revision, while changed content conflicts. Operator edits never consume observations. Restore has its own idempotency ledger and moves only the active pointer, so the next automatic or operator revision names the restored revision as its predecessor.

Pause and resume operations have their own idempotency ledger. Identical replay returns the operation's stored result before inspecting the current generation; a new operation locks the control singleton, checks `expected_generation` and the legal transition, then increments generation. A new maintenance revision locks that same row in its commit transaction and is rejected while paused with the `MAINTENANCE_PAUSED` conflict code, distinct from a revision compare-and-swap conflict. Operator revisions are unaffected. Worker preflight reads only avoid unnecessary work and do not replace this transaction boundary.

## Run Locally

The schema runner verifies applied SQL checksums. An existing database whose applied `001` differs from the checked-in schema must be explicitly upgraded or recreated; editing the SQL file does not migrate it.

```bash
MEMORY_CATALOG_DATABASE_URL=postgresql://... \
MEMORY_CATALOG_WORKER_TOKEN=... \
MEMORY_CATALOG_OPERATOR_TOKEN=... \
pnpm run server
```

Worker credentials register extractions and run automatic maintenance. Operator credentials power catalog reads and the Control Plane UI's pause, edit, restore, and resume operations. The server derives operator audit actors from the authenticated role.

## Checks

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

`pnpm test` runs the isolated unit and server tests. `pnpm run test:integration` exercises the PostgreSQL store against an explicitly supplied `TEST_DATABASE_URL`; when it is unset, the launcher creates and removes a temporary local Docker PostgreSQL instance using the image configured in the repository `compose.yaml`. The launcher deliberately ignores the service's ordinary `MEMORY_CATALOG_DATABASE_URL` so a test cannot modify a shared database by accident.
