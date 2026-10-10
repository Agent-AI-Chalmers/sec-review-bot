# Integration Contract

Language: English | [中文](README.zh.md)

This family is the supported public integration point between the Runner and its callers. It has two layers:

1. Production transport: the HTTP Agent Runner Service.
2. Data contract: runner inputs, workflow results, `ReviewRecord`, and repository
   `deliveries[]`.

Use these documents:

- [openapi.json](openapi.json): how callers create and poll workflow runs — paths, status
  codes, request and response shapes, and the security scheme.
- [v5/CONTRACT.md](v5/CONTRACT.md): workflow input and result shapes.
- [v5/schemas](v5/schemas): JSON Schemas for machine validation.
- [v5/fixtures](v5/fixtures): executable JSON examples shared by Python and TypeScript
  tests.

The HTTP API and the workflow contract are the stable public interface.

## Public Boundary

Callers can rely on:

- the runner HTTP API;
- public workflow names accepted by the HTTP API;
- runner input and public workflow result shapes for the current `contract_version`;
- structured runner success and error response bodies.

The following are not stable public APIs:

- internal Python module paths under `agents`;
- Temporal workflow names or workflow/stage implementation details;
- diagnostic stage artifact shapes unless explicitly documented as contract fields;
- GitHub integration internal orchestration details;
- non-contract fields used only by publishing strategy or local tooling.

## Ownership

Callers are responsible for:

- materializing input bundles;
- invoking workflows through the HTTP transport;
- consuming structured result/error responses;
- deciding how to render or publish results;
- handling platform-specific publishing rules, such as GitHub PR de-duplication.

Agents are responsible for:

- executing structured orchestration for issue, pull request, and repository workflows;
- producing structured workflow results centered on `review_record` and repository
  `deliveries[]`;
- saving stage artifacts.

The GitHub integration is one implementation of the caller side: it turns GitHub events and publishing rules into runner inputs and result publication.

This split is also a security boundary. GitHub identity, permissions, API calls, publishing, retry, and audit behavior stay on the caller side. Agents operate inside the runner contract and do not directly control GitHub platform capabilities.

## Generated Specification

[openapi.json](openapi.json) is the runner service's OpenAPI document, generated from its code. The service also serves it at `/openapi.json` and a readable view at `/docs`; both are deliberately reachable without the service token, because an API description carries no run data or credentials.

## Runner Error Codes

These are the stable machine-readable codes a caller may branch on. The set is open: a failure the service cannot classify yet arrives as `RUNNER_EXECUTION_FAILED`, and new codes are added rather than reusing an existing one for a different meaning.

- `RUNNER_REQUEST_INVALID`
- `RUNNER_WORKFLOW_UNSUPPORTED`
- `RUNNER_RUN_CONFLICT`
- `RUNNER_RUN_NOT_FOUND`
- `RUNNER_RESPONSE_INVALID`
- `RUNNER_EXECUTION_FAILED`

## Compatibility Rules

The following changes are breaking changes:

- HTTP path / method changes
- the status code that carries a given outcome, or the shape of the body it carries
- required request / response field changes
- required error body field changes
- workflow name or input required field changes

Adding an endpoint, an endpoint option, or an optional request/response field is a
non-breaking extension.

## Enforcement

The schema files are the executable structural form of the specification. The current version uses [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12). The Python Runner enforces input and result schemas with [jsonschema](https://python-jsonschema.readthedocs.io/), and the TypeScript integration independently enforces them with [Ajv](https://ajv.js.org/). Both packages also execute the shared fixtures in tests.

The agents wheel includes a build-time copy of the canonical schemas as package data, so installed Python tools do not depend on the repository-level `contracts/` path at runtime.

> Cross-field invariants that portable JSON Schema cannot express, such as repository
> incremental `base_sha != head_sha`, are enforced by runtime input validation. Platform
> publishing policy, such as whether a schema-valid file path may be published to a
> sensitive GitHub location, stays with the caller.

Runtime parsers may also enforce canonical forms that schemas intentionally leave structural, such as enum normalization, unsupported public fields, and publishable repository path policy. Treat those parser checks as part of the runtime boundary for each consumer, not as replacement schema definitions.

## Artifact Boundary

Stage artifacts are runtime diagnostics unless a field is explicitly promoted into the public workflow result. Public results are `review_record`, repository `case_results[]`, repository `deliveries[]`, and the other fields documented in [v5/CONTRACT.md](v5/CONTRACT.md).

Callers should publish from the workflow result, not by reading whole stage artifact packages. If a stage artifact becomes necessary for caller behavior, either promote the required field into this contract or keep the dependency private to a local debugging tool.
