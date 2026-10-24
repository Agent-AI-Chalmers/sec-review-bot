# Memory Catalog

Language: English | [中文](README.zh.md)

`memory-catalog/` exposes the HTTP API that coordinates observation processing and memory tree revision commits. Coordination state is stored in PostgreSQL. Workers publish immutable memory trees and memory-agent audit bundles to object storage, and the catalog stores their artifact references.

## API

| Method | Path                               | Purpose                                                                                                |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET`  | `/healthz`                         | Report service health.                                                                                 |
| `POST` | `/v1/observations`                 | Register an observation or replay an identical registration.                                           |
| `GET`  | `/v1/observations/pending-summary` | Return the count and oldest age of pending observations.                                               |
| `POST` | `/v1/maintenance/batches/select`   | Select a bounded observation batch against the active revision.                                        |
| `POST` | `/v1/maintenance/complete`         | Commit a new memory tree revision with compare-and-swap and mark its source observations as processed. |
| `GET`  | `/v1/active-version`               | Return the artifact reference for the active memory tree.                                              |
| `GET`  | `/v1/revisions`                    | List memory tree revision history.                                                                     |
| `GET`  | `/v1/revisions/{revision}`         | Return one revision and its maintenance audit reference.                                               |

The service owns its PostgreSQL database and its `schema_versions` ledger. The default integrated deployment places that database beside, but separate from, the Control Plane database in the same PostgreSQL instance.

## Run Locally

```bash
MEMORY_CATALOG_DATABASE_URL=postgresql://... \
MEMORY_CATALOG_TOKEN=... \
pnpm run server
```

## Checks

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```
