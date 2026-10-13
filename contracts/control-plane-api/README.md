# Control Plane API

Language: English | [中文](README.zh.md)

This family holds the shapes Control Plane exchanges with its callers. The single source of truth is the hand-written [openapi.yaml](openapi.yaml); routes, request/response schemas, and security all derive from it. Two surfaces answer to different credentials: the redacted read surface the console consumes, and the full read/write surface the GitHub integration calls.

Use these documents:

- [openapi.yaml](openapi.yaml): the OpenAPI 3.1 contract — every operation (with `operationId`), its request/response schemas, security schemes, and the `components.schemas` domain shapes.
- [v1/observed-run.schema.json](v1/observed-run.schema.json): the redacted shape a read response returns.
- [v1/review-run-record.schema.json](v1/review-run-record.schema.json): the coordination record shape.
- [v1/fixtures](v1/fixtures): executable examples, including the shapes this contract must reject.

## Boundary

The Control Plane produces each observed run from `observeRun()` and each record from `rowToRecord()`. The record carries `failure_message`, which the redacted read shape deliberately drops, so it only ever crosses the service-token boundary.

The GitHub integration imports Control Plane's shapes directly, so its view of the record is the same type rather than a hand-written copy. The console instead pins its own `Run` type to the committed fixture, so the two callers keep their own compile-time ties to the one schema.

Both sides of a request are typed from the contract too, not only the response: the integration's client takes the contract's own `operationId` and derives each request body and success value from it, and the Control Plane's route handlers read `request.body` and `request.params` through their operation's types (`control-plane/src/route-types.ts`). Renaming a request field in [openapi.yaml](openapi.yaml) therefore fails both typechecks, rather than leaving a call site that compiles while the field is quietly ignored.

## Public Boundary

Consumers can rely on:

- the field names and required fields of an observed run;
- the two status axes, `execution_status` and `publication_status`, as separate values;
- the `artifact_storage` variants: absent; an error variant whose status is `unavailable` or `failed`, with optional `error_code` and `message`; or `available` with a stored bundle.

The following are not part of this contract:

- internal store records, such as the row shape persisted in Postgres;
- anything the console derives for display, such as relative times or phase durations.

## Enforcement

The console pins its own `Run` type to the fixture at build time: if the fixture gains, loses, or renames a field, the console stops compiling until its type follows. That check lives in `apps/control-plane-ui/test/observed-run-fixture-types.ts` and compares key sets rather than values, because TypeScript widens JSON strings and a value-level assignment would reject a correct fixture.

The Control Plane owns the value-level half in `control-plane/test/observed-run-contract.test.ts`: it validates every fixture as the manifest claims, and validates what `observeRun()` actually returns. The type↔schema binding needs no separate key-set comparison because both derive from the same `ObservedRun` in the contract (`openapi.yaml`). A status outside the schema enums, a broken pattern, or a malformed timestamp therefore fails the suite instead of reaching the console.

## Error codes

- **Validation codes** — `INVALID_QUERY`, `INVALID_BODY`, and `INVALID_PATH_PARAMETER` — name which part of a request failed the contract's own schema, so a caller classifying by `code` can tell a bad run-list filter from a bad body from a bad path parameter. They surface as an HTTP 400 with a string `code`. The server projects the whole enum into `ERROR_RESPONSE_CODES_FROM_CONTRACT` and refuses to emit a code the contract omits, so the envelope cannot advertise a value outside [openapi.yaml](openapi.yaml)'s `ErrorResponse.code` enum.
- **Control-flow codes** — the four `PUBLICATION_STEP_*` codes the Control Plane emits as terminal publication failures — are single-sourced in [openapi.yaml](openapi.yaml)'s `ErrorResponse.code` enum and surface on the write surface as an HTTP 409 with a string `code`. The server's `PUBLICATION_STEP_ERROR_CODES` (control-plane) is a projection of that enum, and the GitHub integration classifies each as `retry: false`, so a new code on one side is caught by `publication-error-code-alignment.test.ts` rather than silently looping the runner forever.
- **Diagnostic codes** (`failure_code`, the runner error `code`) are open sets and remain un-enumerated until their vocabulary stabilizes.
