# Contract TypeScript Code Generation

Language: English | [中文](README.zh.md)

This development-only package provides the OpenAPI-to-TypeScript generation rules shared by the Execution API, Review Runs API, and Memory Catalog API tools. The tools for each contract maintain its specification, generation command, output manifest, formatting, and generated-output consistency checks.

Consumers declare a `workspace:*` dependency. Run `pnpm install --frozen-lockfile` from the repository root to use the shared workspace lockfile. The package exports TypeScript source; consumers run it with `node --import tsx`, as the contract tools do. No separate build is needed.

`renderOpenApiTypes()` returns Kubb's declarations unchanged, followed by two operation maps keyed by `operationId`. Consumers use only these maps for operation-level types. `OperationOptionsById` holds each operation's request options (path, query, headers, body). `OperationResponseById` holds its successful response body: the bodies of its 2xx statuses, plus `void` for a 2xx status without a body. Error bodies never count as success, unlike Kubb's own `…ResponseBody` aggregate, which falls back to error bodies when no success status has one and whose generated description is not authoritative. Generation fails instead of producing a misleading body type when an operation declares no 2xx status, when 2xx content omits its schema, when a 2xx status has several content types, when a status range such as `2XX` is used, when a response reference points outside `components.responses`, or when a path item is itself a `$ref`. Kubb's resolver names the per-operation aggregates `…ResponseBodyByStatus` and `…ResponseBody` so they cannot collide with contract schema names such as `HealthResponse`. Compiler-based tests check the resulting type semantics without requiring a particular declaration shape.

`formatGenerated()` reads the output destination’s nearest `.oxfmtrc.json` on each render. Generated Markdown preserves semantic paragraphs and embedded examples. Ignore patterns control CLI file selection, not whether a declared projection is rendered. Unsupported config overrides fail explicitly rather than silently changing output. Register this helper and each destination config in the owning artifact manifest’s `code_inputs`.

Run checks from this directory:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

Behavioral probes belong here; each contract tool separately tests its generated outputs and freshness. After renderer changes, regenerate all three API contracts and run checks in their consumer packages.
