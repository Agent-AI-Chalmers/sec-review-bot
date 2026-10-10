# Control Plane API

Language: English | [中文](README.zh.md)

This family holds the shapes Control Plane exchanges with its callers. It covers two surfaces that answer to different credentials: the read surface the console consumes, and the store operations the GitHub integration calls.

Use these documents:

- [v1/observed-run.schema.json](v1/observed-run.schema.json): the redacted shape a read response returns.
- [v1/review-run-record.schema.json](v1/review-run-record.schema.json): the coordination record exchanged over `POST /v1/store`.
- [v1/fixtures](v1/fixtures): executable examples, including the shapes this contract must reject.

## Boundary

The Control Plane produces each observed run from `observeRun()` and each record from `rowToRecord()`. Neither caller imports this package, so both carry their own type for the shape they read; these schemas are what keep all three descriptions in step.

The record carries `failure_message`, which the redacted read shape deliberately drops, so it only ever crosses the service-token boundary.

## Public Boundary

Consumers can rely on:

- the field names and required fields of an observed run;
- the two status axes, `execution_status` and `publication_status`, as separate values;
- the `artifact_storage` variants: absent, unavailable, or available with a stored bundle.

The following are not part of this contract:

- internal store records, such as the row shape exchanged over `POST /v1/store`;
- the flattened status, which appears only on those store records;
- anything the console derives for display, such as relative times or phase durations.

## What Is Not Schematized

Three payloads have no schema: the admission envelope, the publication claim result, and the publication step record. Each is tied to Control Plane's own type at compile time instead, by `apps/github-integration/test/control-plane/client-mirrored-types.ts`.

A schema for them would be a second description nobody validates at runtime: the integration parses each response and casts it, so a schema needs a validator at that call site before it enforces anything. Until that validator exists, the compile-time tie is what enforces them; adding schema files without one would change nothing.

## Enforcement

The console pins its own `Run` type to the fixture at build time: if the fixture gains, loses, or renames a field, the console stops compiling until its type follows. That check lives in `apps/control-plane-ui/test/observed-run-fixture-types.ts` and compares key sets rather than values, because TypeScript widens JSON strings and a value-level assignment would reject a correct fixture.

The Control Plane owns the value-level half in `control-plane/test/observed-run-contract.test.ts`. It compares its own response type to the schema by key set, validates every fixture as the manifest claims, and validates what `observeRun()` actually returns. A status outside the schema enums, a broken pattern, or a malformed timestamp therefore fails the suite instead of reaching the console.
