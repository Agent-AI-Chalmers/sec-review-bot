# Memory Catalog

Language: English | [中文](README.zh.md)

Memory Catalog provides an HTTP API to record completed extractions, manage pending observations, and retain memory-tree revision history and the active revision.

## API

| Method | Path                                   | Purpose                                                                                                               |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                             | Report service health.                                                                                                |
| `POST` | `/v1/extractions`                      | Register a completed extraction, its trajectory reference, and its optional observation.                              |
| `GET`  | `/v1/extractions`                      | List completed extractions with stable cursor pagination and provenance filters.                                      |
| `GET`  | `/v1/extractions/{extraction_id}`      | Return one extraction, its trajectory reference, and its optional observation.                                        |
| `GET`  | `/v1/observations`                     | List observations with stable cursor pagination and consumption filters.                                              |
| `GET`  | `/v1/overview`                         | Summarize completed extraction coverage, observation outcomes, and a 30-day, 90-day, or all-time trend.               |
| `GET`  | `/v1/observation-backlog`              | Return the count and oldest age of pending observations.                                                              |
| `GET`  | `/v1/memory-tree/automation`           | Return the durable `enabled` or `paused` memory-tree automation admission state.                                      |
| `POST` | `/v1/memory-tree/automation/pause`     | Idempotently pause automatic memory-tree commits with generation compare-and-swap.                                    |
| `POST` | `/v1/memory-tree/automation/resume`    | Idempotently resume automatic memory-tree commits with generation compare-and-swap.                                   |
| `GET`  | `/v1/learning-input?limit=...`         | Return up to `limit` observations and the active memory state they must be maintained against.                        |
| `POST` | `/v1/memory-tree/revisions`            | Create a learning, reorganization, or manual revision with idempotency and expected-active-revision compare-and-swap. |
| `GET`  | `/v1/memory-tree`                      | Return the current memory tree and its revision.                                                                      |
| `POST` | `/v1/memory-tree/restore`              | Move the active pointer to an existing revision without creating a revision.                                          |
| `GET`  | `/v1/memory-tree/revisions`            | List memory tree revision history.                                                                                    |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | Return one memory tree revision, its source identity, and its artifact references.                                    |

## Usage Notes

### Storage And Pagination

The service uses its own PostgreSQL database, with applied schema versions recorded in `schema_versions`. The default integrated deployment shares a PostgreSQL instance with Review Runs but uses separate databases.

Extractions and observations are ordered by `created_at` and then `extraction_id`, both descending. Callers should paginate with the returned cursor without interpreting its contents; the next page excludes the cursor item.

### Revisions And Memory-Tree Automation

Revision sources use `learning` for incorporating new observations, `reorganization` for reorganizing existing memory, and `manual` for human edits. `predecessor_revision` records the revision active at creation. Restoring an earlier revision only changes the active revision; it creates no new revision, and later revision numbers continue increasing. Manual edits do not consume pending observations.

<!-- doc-default: memory-tree-automation-state; source=services/memory-catalog/src/database/schema-versions/001_initial_catalog.sql -->

Memory-tree automation supports `enabled` and `paused`, initially `enabled`. This state controls admission of new `learning` and `reorganization` revision commits, not worker execution. Pause and resume requests require `operation_id` and `expected_generation`; responses contain `created` and an `automation` snapshot. Paused commits return HTTP 409 with `AUTOMATION_PAUSED`. Pausing does not cancel running work or block extraction registration, artifact publication, manual revisions, restores, or identical replays of successful commits.

Only one maintenance task may run at a time, enforced by Temporal's fixed workflow ID and `SKIP` overlap policy.

A worker can abandon existing unselected automatic revision publications with `POST /v1/memory-tree/revisions/publications/abandon`. The `abandoned` state is final for those candidates: reserve and confirm retries preserve it, while commit returns HTTP 409 with `PUBLICATION_ABANDONED`. A paused automatic commit atomically abandons the existing unselected publications for its source kind and operation ID before returning `AUTOMATION_PAUSED`. Maintenance workflows also abandon on a pause observed during preparation and exit without backlog continuation. Selected publications remain replayable; artifact objects are retained.

### Publication And Retries

To publish an extraction result or memory revision, first record a publication intent containing the complete result and artifact references, then upload the files, confirm the upload, and register the result. Registration must match the confirmed publication intent.

After an interruption, retries check recorded intents and storage objects before deciding whether to rerun the model. A storage access failure does not mean an object is missing. If an object referenced by a registered result is lost, recovery must fail rather than replace it with a new result.

Manual edit retries reuse the operation ID and original expected revision. Identical content returns the original result; changed content conflicts. The protocol does not automatically clean up unreferenced objects or complete publications after retries are exhausted. See [SYSTEM_ARCHITECTURE](../../docs/architecture/SYSTEM_ARCHITECTURE.md#artifact-publication-and-recovery) for the detailed flow.

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
