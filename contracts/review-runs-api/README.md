# Review Runs API

Language: English | [中文](README.zh.md)

This contract holds the shapes Review Runs exchanges with its callers. The single source of truth is the hand-written [v1/openapi.yaml](v1/openapi.yaml); routes, request/response schemas, and security all derive from it. Two surfaces answer to different credentials: the redacted read surface the console consumes, and the full read/write surface the GitHub Integration calls.

Use these documents:

- [v1/openapi.yaml](v1/openapi.yaml): the OpenAPI 3.1 contract, covering every operation (with `operationId`), its request/response schemas, security schemes, and the `components.schemas` domain shapes.
- [v1/observed-run.schema.json](v1/observed-run.schema.json): the redacted shape a read response returns.
- [v1/review-run-record.schema.json](v1/review-run-record.schema.json): the coordination record shape.
- [v1/fixtures](v1/fixtures): executable examples, including the shapes this contract must reject.

Input publication operations reserve a complete immutable publication intent under a preparation claim, list publication intents for recovery, and settle publication presence or abandonment. A prepared submission must match a present or already selected publication intent in full. Identical submission replay is accepted while preparation still owns the run; changing the reference, input, or publish context is rejected. Candidate records contain storage locators and prepared input, so they belong to the authenticated service coordination surface and are not part of the console's observed-run projection.

## Run States

The `x-state-machines` block in [v1/openapi.yaml](v1/openapi.yaml) defines every lifecycle state and allowed transition. [v1/STATE_MACHINES.md](v1/STATE_MACHINES.md) is generated from it for reading, and [v1/STATE_MACHINES.zh.md](v1/STATE_MACHINES.zh.md) from it plus the Chinese overlay [v1/overlays/zh.yaml](v1/overlays/zh.yaml), an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html) that replaces only titles, labels, and descriptions. Each page has one diagram per machine, what each state means, and every transition. The console shows the same text in both languages.

## Boundary

Review Runs exposes redacted observed runs to read-token callers and full coordination records to service-token callers. Only the full record includes `failure_message`.

## Public Boundary

Consumers can rely on:

- the field names and required fields of an observed run;
- `source_platform`, the stable source-code-hosting platform used for aggregation, and `connector_id`, the connector type and instance namespace that admitted and owns the run;
- the three lifecycle axes as nested objects: the redacted `preparation` summary, and `execution` / `publication`. Each reports its own `status`, `started_at`, `finished_at`, and `updated_at` (the axis' last write, not a phase bound); the query parameters that filter them keep the established `*_status` spelling;
- `notices`: messages that an integration should show when part of the run fails or needs attention. They are ordered from oldest to newest, and separate events remain separate entries;
- `execution_statistics`: a nullable Review Runs snapshot of reconciliation state, observed model-call/token totals, and workflow-coordinate/agent/provider/model groups. Case, delivery, agent-phase, feedback-retry, draft-batch, and discovery-chunk coordinates are nullable because most stages do not have them. `agent_phase` identifies the task (such as initial review, feedback, draft, or refinement); `feedback_retry_index` numbers verifier-feedback retries from 1 and is null for other work. `null` for the whole snapshot means no snapshot row exists; it does not mean zero usage;
- execution-statistics token totals use OpenTelemetry GenAI semantics: `input_tokens` and `output_tokens` include their reported cache and reasoning subsets. Langfuse's mutually exclusive billing buckets are normalized before they enter this contract;
- token fields are nullable: `null` means the value could not be established for every covered call, never zero. `input_tokens`, `output_tokens` and their subsets are independently nullable; `total_tokens` is computed as their sum and is null whenever either is missing. Cache and reasoning fields are subsets and must not be added to the totals;
- the `artifact_storage` variants: absent; an error variant whose status is `unavailable` or `failed`, with optional `error_code` and `message`; or `available` with a stored bundle.

## Enforcement

Consumers use the contract-generated types, and the contract tools check that committed projections match a fresh render. Consumer type tests verify that an available archive requires its reference, including URI and digest, while an unavailable archive needs no reference.

Review Runs validates the shared fixtures against their manifest and checks actual read responses against the response schemas. Types and schemas derive from the same `ObservedRun` definition in `openapi.yaml`. Values outside the status enums, patterns, or timestamp formats are rejected by those checks.

## Tooling

Run from `tools/`:

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```

## Error codes

- **Validation codes** (`INVALID_QUERY`, `INVALID_BODY`, and `INVALID_PATH_PARAMETER`) name which part of a request failed the contract's own schema, so a caller classifying by `code` can tell a bad run-list filter from a bad body from a bad path parameter. A run-list request also validates strictly against the declared query parameters: an undeclared query parameter is rejected as `INVALID_QUERY`, not ignored, because `listRuns` models its filters as one `additionalProperties: false` object rather than a bare parameter list. They surface as an HTTP 400 with a string `code`. The server projects the whole enum into `ERROR_RESPONSE_CODES_FROM_CONTRACT` and refuses to emit a code the contract omits, so the envelope cannot advertise a value outside [openapi.yaml](v1/openapi.yaml)'s `ErrorResponse.code` enum.
- **Control-flow codes** (the four `PUBLICATION_STEP_*` codes Review Runs emits as terminal publication failures) are single-sourced in [openapi.yaml](v1/openapi.yaml)'s `ErrorResponse.code` enum and surface on the write surface as an HTTP 409 with a string `code`. The server's `PUBLICATION_STEP_ERROR_CODES` (review-runs) is a projection of that enum, and GitHub Integration consumes the generated `REVIEW_RUNS_PUBLICATION_ERROR_CODES` map instead of restating the strings. Confirmed refusals stop retries; consumer tests check the classification against the source contract. An exhaustion code on a transport failure remains retryable because it does not establish a service refusal.
- **Responses with no `code`**: every operation declares an HTTP 500 (`InternalError`) for an internal fault, and every operation that reads a request body an HTTP 413 (`PayloadTooLarge`) for a body over the 1 MiB limit. Neither carries a `code`: the fault is deliberately opaque, and an oversized body is rejected before the contract's own schema sees it. A Spectral rule (`operation-declares-server-errors`) fails a new operation that omits them.
- **Diagnostic codes** (`failure_code`, the execution error `code`) are open sets and remain un-enumerated until their vocabulary stabilizes.
