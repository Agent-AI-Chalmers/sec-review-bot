# Memory Catalog

Language: English | [中文](README.zh.md)

`memory-catalog/` is the independently deployable TypeScript managed-memory data boundary for Sec Review Bot.

It owns the PostgreSQL catalog, observation registration, immutable memory revision history, the active revision pointer, and compare-and-swap maintenance commit. It does not run agents, read transcripts, access object storage, or poll Temporal task queues.

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
