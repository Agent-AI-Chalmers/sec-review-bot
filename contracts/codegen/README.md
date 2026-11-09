# Contract TypeScript Code Generation

Language: English | [中文](README.zh.md)

This development-only package provides the OpenAPI-to-TypeScript generation rules shared by the Execution API, Review Runs API, and Memory Catalog API tools. The tools for each contract maintain its specification, generation command, output manifest, formatting, and generated-output consistency checks.

Consumers declare a `workspace:*` dependency. Run `pnpm install --frozen-lockfile` from the repository root to use the shared workspace lockfile. The package exports TypeScript source; consumers run it with `node --import tsx`, as the contract tools do. No separate build is needed.

Kubb's resolver names operation aggregates `…ResponseBodyByStatus` and `…ResponseBody`, keeping them distinct from contract schema names such as `HealthResponse`. The status map contains response bodies directly, including their generated documentation. Intermediate `StatusNNN` aliases are removed. The aggregate indexes exactly the statuses Kubb selected: success responses when available, otherwise its response-body fallback. It represents a body, not an HTTP response carrying a status discriminator.

The renderer uses Kubb's supported resolver for naming and a syntax-aware normalization for the response map and aggregate. Unsupported output fails generation instead of silently retaining a different shape. It does not rewrite unrelated schema declarations or contract data.

Run checks from this directory:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

Behavioral probes belong here; each contract tool separately tests its generated outputs and freshness. After renderer changes, regenerate all three API contracts and run checks in their consumer packages.
