# Memory Catalog API

Language: English | [中文](README.zh.md)

[v1/openapi.yaml](v1/openapi.yaml) is the hand-maintained single source of truth for the Memory Catalog Server HTTP boundary. It is not generated from service code. The server mounts routes and validation from it, generated TypeScript types bind handlers to operation bodies, and Python client contract tests validate the payloads and responses it consumes.

The contract deliberately excludes PostgreSQL rows, Temporal workflow state, transcript contents, and object-storage credentials.

Generate committed projections from `tools/`:

```bash
pnpm install
pnpm run generate
pnpm test
```
