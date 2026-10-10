# Agent Runner HTTP API

Language: English | [中文](RUNNER_HTTP_API.zh.md)

This is the HTTP API for the production runner service. Workflow input and result fields are defined in [integration-contract/v5/CONTRACT.md](v5/CONTRACT.md).

## Authentication

When `RUNNER_SERVICE_TOKEN` is set, every endpoint requires:

```http
Authorization: Bearer <token>
```

When `RUNNER_SERVICE_TOKEN` is unset, the service only starts when `RUNNER_SERVICE_HOST` is loopback, such as `127.0.0.1` or `localhost`. Compose and any non-loopback service binding require an explicit `RUNNER_SERVICE_TOKEN`.

## Supported Workflows

- `issue-review`
- `pull-request-review`
- `repository-review`

`issue-review-two-stage` and `issue-review-single-agent` are local evaluation / ablation paths. They may be started by local CLI as local-only Temporal workflows, but they are not accepted by the standard HTTP API and external callers must not depend on them.

## Create Run

```http
POST /v1/workflows/{workflow}/runs
```

### Request Body

```json
{
  "run_id": "run-001",
  "input": {},
  "runtime": {}
}
```

Field requirements:

- `workflow`: path parameter; must be a public workflow name.
- `run_id`: caller-chosen run identifier; must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. The runner uses it to identify this run and choose the artifact directory. Invalid values fail synchronously with `RUNNER_REQUEST_INVALID`; the runner does not normalize or trim `run_id`.
- `input`: workflow input object.
- `runtime`: optional runner runtime config.

Allowed `runtime` keys are `workspace_image?: string`. Unknown runtime keys fail runner preparation with `RUNNER_REQUEST_INVALID`; create-run only performs lightweight synchronous validation and may still return accepted/running.

`runtime.workspace_image` is currently an internal / evaluation runner option. The GitHub App does not expose it through repository config. Product integrations must not derive or pass this value from repository configuration, comments, issue / PR content, or other untrusted user-controlled input.

`run_id` is also the create-run idempotency key. While the corresponding workflow remains available within Temporal retention, the first accepted request binds the ID to the canonical JSON value of `workflow`, `input`, and `runtime`:

- Replaying the same request with the same `run_id` returns the existing run, including after that run has completed.
- Reusing the same `run_id` with different request content returns HTTP `409` with `RUNNER_RUN_CONFLICT`.
- A completed, failed, cancelled, or timed-out run ID is not reused for a new Temporal execution.

> After Temporal deletes an expired workflow history, the runner can no longer recover that ID's request binding. Callers must generate a fresh, collision-resistant `run_id` for every new run and must not intentionally reuse expired IDs. Permanent deduplication beyond Temporal retention is not part of this API contract.

JSON object key order does not affect request identity. Changes to array order or field values do.

Supported public workflows:

- `issue-review`
- `pull-request-review`
- `repository-review`

### Accepted Response

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "running"
}
```

## Get Run

```http
GET /v1/runs/{run_id}
```

### Running Response

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "running"
}
```

### Succeeded Response

The Runner reports `succeeded` only after the workflow completes and its result matches the public v5 schema for that workflow. A completed workflow that returns an invalid public result is reported as failed with `RUNNER_RESPONSE_INVALID`; the Runner does not guess how to repair contract fields at this boundary.

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "succeeded",
  "result": {},
  "artifact_storage": {
    "status": "available",
    "artifact": {
      "kind": "diagnostic_bundle",
      "uri": "s3://sec-review/runs/run-001/artifacts/diagnostic-tree.v1.tar.zst",
      "media_type": "application/zstd",
      "digest": "sha256:0123456789abcdef...",
      "size_bytes": 12345
    }
  }
}
```

`artifact_storage` is separate from the workflow result. Its status is `available`, `unavailable`, or `failed`; storage failure does not change the workflow's business result.

### Failed Response

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "failed",
  "error": {
    "category": "runtime",
    "code": "RUNNER_EXECUTION_FAILED",
    "message": "RuntimeError: boom from issue analyzer",
    "retryable": false,
    "details": {
      "temporal_status": "FAILED",
      "name": "RuntimeError",
      "failure_chain": [
        {
          "name": "WorkflowFailureError",
          "message": "Workflow execution failed"
        },
        {
          "name": "RuntimeError",
          "message": "RuntimeError: boom from issue analyzer"
        }
      ]
    }
  }
}
```

## Get Run Statuses

`POST /v1/runs/status` reads many run statuses in one request. It exists for a caller that tracks several runs: asking [Get Run](#get-run) once per run makes the request count grow with the number of runs in flight, so the busiest moments issue the most requests.

The response carries status tokens only. A caller that needs what a run produced fetches that run once through [Get Run](#get-run) when it reaches a terminal status, instead of receiving every result on every interval.

### Request Body

```json
{
  "run_ids": ["6f1c8f2a-2d3e-4a5b-8c7d-9e0f1a2b3c4d"]
}
```

- `run_ids`: required. At least one and at most 200, each matching the run ID rule.
  A repeated ID is read once.

### Status Response

```json
{
  "runs": [
    { "run_id": "6f1c8f2a-2d3e-4a5b-8c7d-9e0f1a2b3c4d", "status": "running" },
    { "run_id": "0a94c1de-3f4a-4b6c-9d8e-1f2a3b4c5d6e", "status": "succeeded" }
  ],
  "missing": ["3b77aa10-5c6d-4e7f-8a9b-0c1d2e3f4a5b"]
}
```

- `runs`: one entry per known run, in the order requested, each carrying the run's
  `run_id` and `status`.
- `missing`: requested run IDs the Runner holds no record for. They are reported instead
  of dropped so that a caller can tell "never accepted" apart from "the Runner skipped it" without comparing the response against its own request.

## Error Responses

### Error Body

Synchronous request validation errors return HTTP `400` with:

```json
{
  "error": {
    "category": "input",
    "code": "RUNNER_REQUEST_INVALID",
    "message": "...",
    "retryable": false,
    "details": {}
  }
}
```

A conflicting reuse of a `run_id` that remains available within Temporal retention returns HTTP `409` with the same error envelope and code `RUNNER_RUN_CONFLICT`. This error is not retryable; callers must either replay the original request or choose a new `run_id` for a new request.

error fields:

- `category`: input | workflow | llm | runtime | internal
- `code`: stable machine-readable error code
- `message`: short readable error message
- `retryable`: boolean
- `details`: diagnostic object

Runtime failures are not disguised as workflow `result` or stage-level `status="error"`. Activity / child workflow exceptions are handled by Temporal retry and workflow failure. When `GET /v1/runs/{run_id}` reaches final failure, it returns `RUNNER_EXECUTION_FAILED`; `message` should contain the Temporal failure root cause, and `details.failure_chain` may contain the diagnostic chain from Temporal wrapper error to root cause.

When the Runner has no stored execution for a valid run ID, `GET /v1/runs/{run_id}` returns HTTP `404` with `RUNNER_RUN_NOT_FOUND`. A generic route `404` is not this error and must not be treated as evidence that the run is gone.

### Runner Error Codes

- `RUNNER_REQUEST_INVALID`
- `RUNNER_WORKFLOW_UNSUPPORTED`
- `RUNNER_RUN_CONFLICT`
- `RUNNER_RUN_NOT_FOUND`
- `RUNNER_RESPONSE_INVALID`
- `RUNNER_EXECUTION_FAILED`

## Compatibility Rules

The following changes are breaking changes:

- HTTP path / method changes
- required request / response field changes
- required error body field changes
- workflow name or input required field changes

Adding an endpoint, an endpoint option, or an optional request/response field is a non-breaking extension.
