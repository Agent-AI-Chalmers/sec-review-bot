# Execution API

Language: English | [中文](README.zh.md)

This family defines the complete public Execution API: HTTP operations, execution inputs, workflow results, errors, `ReviewRecord`, and repository `deliveries[]`. A version applies to that complete surface; transport and payload schemas do not carry independent versions.

Use these documents:

- [v1/openapi.yaml](v1/openapi.yaml): how callers create and poll workflow runs — paths, status
  codes, request and response shapes, and the security scheme.
- [v1/CONTRACT.md](v1/CONTRACT.md): workflow input and result shapes.
- [v1/schemas](v1/schemas): JSON Schemas for machine validation.
- [v1/fixtures](v1/fixtures): executable JSON examples shared by Python and TypeScript
  tests.

Together these files define Execution API v1.

## Public Boundary

Callers can rely on:

- the Execution API;
- public workflow names accepted by the HTTP API;
- execution input and public workflow result shapes for the current `api_version`;
- structured Execution API success and error response bodies.

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

The GitHub integration is one implementation of the caller side: it turns GitHub events and publishing rules into execution inputs and result publication.

This split is also a security boundary. GitHub identity, permissions, API calls, publishing, retry, and audit behavior stay on the caller side. Agents operate inside the Execution API boundary and do not directly control GitHub platform capabilities.

## Source Of Truth

[v1/openapi.yaml](v1/openapi.yaml) defines the HTTP operations and envelopes. The JSON Schemas in the same version directory define the workflow-specific objects carried by those envelopes. They are maintained and released as one API version, and are not generated from service code. Execution Gateway mounts routes and validation from these files, while the contract tools generate provider and consumer types from them.

The generated TypeScript projection composes the HTTP envelope with the v1 workflow input schemas. This gives the provider a compile-time `workflow`-to-`input` relationship without introducing a shared runtime package.

## Execution Error Codes

These are the stable machine-readable codes a caller may branch on. The set is open: a failure the service cannot classify yet arrives as `EXECUTION_FAILED`, and new codes are added rather than reusing an existing one for a different meaning.

- `EXECUTION_REQUEST_INVALID`
- `EXECUTION_WORKFLOW_UNSUPPORTED`
- `EXECUTION_RUN_CONFLICT`
- `EXECUTION_RUN_NOT_FOUND`
- `EXECUTION_RESPONSE_INVALID`
- `EXECUTION_FAILED`

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

The schema files are the executable structural form of the specification. The current version uses [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12). The Python Execution enforces input and result schemas with [jsonschema](https://python-jsonschema.readthedocs.io/), and the TypeScript integration independently enforces them with [Ajv](https://ajv.js.org/). Both packages also execute the shared fixtures in tests.

The agents wheel includes a build-time copy of the canonical schemas as package data, so installed Python tools do not depend on the repository-level `contracts/` path at runtime.

> Cross-field invariants that portable JSON Schema cannot express, such as repository
> incremental `base_sha != head_sha`, are enforced by runtime input validation. Platform
> publishing policy, such as whether a schema-valid file path may be published to a
> sensitive GitHub location, stays with the caller.

Runtime parsers may also enforce canonical forms that schemas intentionally leave structural, such as enum normalization, unsupported public fields, and publishable repository path policy. Treat those parser checks as part of the runtime boundary for each consumer, not as replacement schema definitions.

## Artifact Boundary

Stage artifacts are runtime diagnostics unless a field is explicitly promoted into the public workflow result. Public results are `review_record`, repository `case_results[]`, repository `deliveries[]`, and the other fields documented in [v1/CONTRACT.md](v1/CONTRACT.md).

Callers should publish from the workflow result, not by reading whole stage artifact packages. If a stage artifact becomes necessary for caller behavior, either promote the required field into this contract or keep the dependency private to a local debugging tool.
