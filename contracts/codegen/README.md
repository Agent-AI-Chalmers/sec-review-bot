# Contract TypeScript Code Generation

Language: English | [中文](README.zh.md)

This development-only package owns the shared OpenAPI-to-TypeScript rendering policy used by the Execution API, Review Runs API, and Memory Catalog API tools. Each family retains its own contract, generation entry point, output manifest, formatting, and freshness check.

Consumers declare a `workspace:*` dependency. Run `pnpm install --frozen-lockfile` from the repository root to install the workspace using its shared lockfile. No separate codegen build is required: JavaScript with checked JSDoc keeps this package directly executable, while `src/index.d.ts` declares the small TypeScript interface.

Kubb's resolver names operation aggregates `…ResponseBodyByStatus` and `…ResponseBody`, keeping them distinct from contract schema names such as `HealthResponse`. The status map contains response bodies directly, including their generated documentation. Intermediate `StatusNNN` aliases are removed. The aggregate indexes exactly the statuses Kubb selected: success responses when available, otherwise its response-body fallback. It represents a body, not an HTTP response carrying a status discriminator.

The renderer uses Kubb's supported resolver for naming and a syntax-aware normalization for the response map and aggregate. Unsupported output fails generation instead of silently retaining a different shape. It does not rewrite unrelated schema declarations or contract data.

Run checks from this directory:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

Behavioral probes belong here; each family separately tests its actual generated contract and freshness. After renderer changes, regenerate all three families and run checks in their consumer packages.
