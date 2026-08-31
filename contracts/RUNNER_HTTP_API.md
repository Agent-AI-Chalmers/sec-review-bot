# Agent Runner HTTP API

Language: English | [中文](RUNNER_HTTP_API.zh.md)

This is the HTTP API for the production runner service. Workflow input and result fields are defined in [CONTRACT_V4.md](CONTRACT_V4.md).

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

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "succeeded",
  "result": {}
}
```

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

error fields:

- `category`: input | workflow | llm | runtime | internal
- `code`: stable machine-readable error code
- `message`: short readable error message
- `retryable`: boolean
- `details`: diagnostic object

Runtime failures are not disguised as workflow `result` or stage-level `status="error"`. Activity / child workflow exceptions are handled by Temporal retry and workflow failure. When `GET /v1/runs/{run_id}` reaches final failure, it returns `RUNNER_EXECUTION_FAILED`; `message` should contain the Temporal failure root cause, and `details.failure_chain` may contain the diagnostic chain from Temporal wrapper error to root cause.

### Runner Error Codes

- `RUNNER_REQUEST_INVALID`
- `RUNNER_WORKFLOW_UNSUPPORTED`
- `RUNNER_RESPONSE_INVALID`
- `RUNNER_EXECUTION_FAILED`

## Compatibility Rules

The following changes are breaking changes:

- HTTP path / method changes
- required request / response field changes
- required error body field changes
- workflow name or input required field changes

Adding optional fields is a non-breaking extension.
