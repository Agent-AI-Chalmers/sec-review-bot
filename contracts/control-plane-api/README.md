# Control Plane API

Language: English | [中文](README.zh.md)

This family holds the shapes Control Plane exchanges with its callers. Today it covers the read surface, the shapes the read-only web console receives when it asks about review runs; the store operations belong here when they are contracted too.

Use these documents:

- [v1/observed-run.schema.json](v1/observed-run.schema.json): the shape of one observed run.
- [v1/fixtures](v1/fixtures): executable examples, including the shapes this contract must reject.

## Boundary

The Control Plane produces each observed run from `observeRun()`. The console does not import this package, so it carries its own type for the same shape; the fixture in this directory is what keeps the two in step.

## Public Boundary

Consumers can rely on:

- the field names and required fields of an observed run;
- the two status axes, `execution_status` and `publication_status`, as separate values;
- the `artifact_storage` variants: absent, unavailable, or available with a stored bundle.

The following are not part of this contract:

- internal store records, such as the row shape exchanged over `POST /v1/store`;
- the flattened status, which appears only on those store records;
- anything the console derives for display, such as relative times or phase durations.

## Enforcement

The console pins its own `Run` type to the fixture at build time: if the fixture gains, loses, or renames a field, the console stops compiling until its type follows. That check lives in `apps/control-plane-ui/test/observed-run-fixture-types.ts` and compares key sets rather than values, because TypeScript widens JSON strings and a value-level assignment would reject a correct fixture.

The Control Plane owns the value-level half in `control-plane/test/observed-run-contract.test.ts`. It compares its own response type to the schema by key set, validates every fixture as the manifest claims, and validates what `observeRun()` actually returns. A status outside the schema enums, a broken pattern, or a malformed timestamp therefore fails the suite instead of reaching the console.
