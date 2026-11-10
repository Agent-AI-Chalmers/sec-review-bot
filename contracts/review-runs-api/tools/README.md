# Review Runs API contract tools

Language: English | [中文](README.zh.md)

This package generates and checks every artifact derived from the [OpenAPI contract](../v1/openapi.yaml): TypeScript types, operation-route mappings, and committed v1 JSON Schemas. The tools live beside the contract and remain responsible for checking outputs written into other packages.

## Commands

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```

`generate` and `check` use the same output descriptions from each generator's `generatedArtifacts()`, avoiding two separately maintained lists. `tools/generated-artifacts.json` records every output and location; tests compare it with the generators and verify CI coverage for each file.

## Layout

```text
tools/
  generated-artifacts.json   what this contract derives and where
  src/
    generate.ts              pnpm run generate
    check.ts                 pnpm run check
    generated-artifact.ts    the { output, render } shape
    repo-root.ts             the repository root, for absolute output paths
    generate-types.ts        the API projections (types, error codes, console params)
    generate-schemas.ts      the committed v1 JSON Schemas
    generate-state-machines.ts  TypeScript view of the contract's x-state-machines
  test/
    generated-artifacts.test.ts       manifest ↔ generators ↔ CI filter
    contract-generation-guards.test.ts  generators fail on input they cannot represent
    response-types.test.ts            every response alias indexes its status map
```
