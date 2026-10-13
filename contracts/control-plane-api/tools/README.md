# Control Plane API contract tools

Language: English

This package renders and checks every artifact derived from [this family's OpenAPI contract](../openapi.yaml): the TypeScript projections and committed v1 JSON Schemas. It lives beside the contract it reads, so the tool that owns a projection is not the package the projection lands in.

## Commands

```bash
pnpm run generate        # render every artifact and write it in place
pnpm run check           # compare every committed artifact to a fresh render
pnpm run lint:contract   # Spectral-lint ../openapi.yaml against ../.spectral.yaml
pnpm run test            # generator guards, manifest match, and CI-filter coverage
```

`generate` and `check` share one description of what is generated (`generatedArtifacts()` in each generator), so they cannot disagree. `tools/generated-artifacts.json` lists what this family derives and where it lands; a test asserts it matches the generators and that CI triggers on every listed artifact.

## Layout

```text
tools/
  generated-artifacts.json   what this family derives and where
  src/
    generate.ts              pnpm run generate
    check-generated-artifacts.ts  pnpm run check
    generated-artifact.ts    the { output, render } shape
    repo-root.ts             the repository root, for absolute output paths
    generate-types.ts        the API projections (types, error codes, console params)
    generate-schemas.ts      the committed v1 JSON Schemas
  spectral-functions/
    operationRequiresSecurity.js     the every-operation-declares-security rule (../.spectral.yaml)
    operationDeclaresServerErrors.js the every-operation-declares-500/413 rule (../.spectral.yaml)
  test/
    generated-artifacts.test.ts       manifest ↔ generators ↔ CI filter
    contract-generation-guards.test.ts  generators fail on input they cannot represent
```
