# Memory Catalog

Language: English | [中文](README.zh.md)

`memory-catalog/` exposes the HTTP API that records completed memory extractions, coordinates observation processing, and commits memory tree revisions. Coordination state is stored in PostgreSQL. Workers publish immutable memory trees and compressed memory-agent transcripts to object storage, and the catalog stores their artifact references.

## API

| Method | Path                                   | Purpose                                                                                             |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                             | Report service health.                                                                              |
| `POST` | `/v1/extractions`                      | Atomically register a completed extraction, its transcript reference, and its optional observation. |
| `GET`  | `/v1/extractions/{extraction_id}`      | Return one extraction, its transcript reference, and its optional observation.                      |
| `GET`  | `/v1/observation-backlog`              | Return the count and oldest age of pending observations.                                            |
| `GET`  | `/v1/maintenance-input?limit=...`      | Return bounded observations and the active memory state they must be maintained against.            |
| `POST` | `/v1/memory-tree/revisions`            | Create a memory tree revision with compare-and-swap and mark its source observations as processed.  |
| `GET`  | `/v1/memory-tree`                      | Return the current memory tree and its revision.                                                    |
| `GET`  | `/v1/memory-tree/revisions`            | List memory tree revision history.                                                                  |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | Return one memory tree revision, its maintenance identity, and its artifact references.             |

The service owns its PostgreSQL database and its `schema_versions` ledger. The default integrated deployment places that database beside, but separate from, the Control Plane database in the same PostgreSQL instance.

Only one maintainer may execute at a time. Temporal enforces that invariant with one fixed workflow ID and a schedule overlap policy of `SKIP`; the catalog therefore does not implement batch leases or concurrent claims.

Temporal records the published artifact references before dispatching the revision commit activity. A commit retry therefore repeats the same idempotent `POST` without rerunning the maintainer.

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
