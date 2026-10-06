# Contracts

Language: English | [中文](README.zh.md)

This directory is the workspace-level home for project-owned contracts.

It contains both human-readable contract documentation and executable contract assets shared across packages in this repository.

## Start Here

The supported public integration point has two layers:

1. Production transport: the HTTP Agent Runner Service.
2. Data contract: runner inputs, workflow results, `ReviewRecord`, and repository `deliveries[]`.

Use these documents:

- [RUNNER_HTTP_API.md](RUNNER_HTTP_API.md): how callers create and poll workflow runs.
- [CONTRACT_V5.md](CONTRACT_V5.md): workflow input and result shapes.
- [schemas/v5](schemas/v5): JSON Schemas for machine validation.
- [fixtures/v5](fixtures/v5): executable JSON examples shared by Python and TypeScript tests.

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
- producing structured workflow results centered on `review_record` and repository `deliveries[]`;
- saving stage artifacts.

The GitHub integration is one implementation of the caller side: it turns GitHub events and publishing rules into runner inputs and result publication.

This split is also a security boundary. GitHub identity, permissions, API calls, publishing, retry, and audit behavior stay on the caller side. Agents operate inside the runner contract and do not directly control GitHub platform capabilities.

## Specs, Schemas, And Fixtures

The Markdown specifications define field semantics, compatibility rules, and integration guidance.

The schema files are the executable structural form of that specification. Contract v5 schemas use [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12). The Python Runner enforces input and result schemas with [jsonschema](https://python-jsonschema.readthedocs.io/), and the TypeScript integration independently enforces them with [Ajv](https://ajv.js.org/). Both packages also execute the shared fixtures in tests.

The agents wheel includes a build-time copy of these canonical schemas as package data. Installed Python tools therefore do not depend on the repository-level `contracts/` path at runtime.

Schemas are structural contract checks, not the complete authority for every runtime or publishing rule.

> Cross-field invariants that portable JSON Schema cannot express, such as repository incremental `base_sha != head_sha`, are enforced by runtime input validation. Platform publishing policy, such as whether a schema-valid file path may be published to a sensitive GitHub location, stays with the caller.

Runtime parsers may also enforce canonical forms that schemas intentionally leave structural, such as enum normalization, unsupported public fields, and publishable repository path policy. Treat those parser checks as part of the runtime boundary for each consumer, not as replacement schema definitions.

The fixture files provide concrete JSON examples that tests can execute against, so they are part of contract validation.

[`fixtures/v5/manifest.json`](fixtures/v5/manifest.json) records which valid fixtures must match and which invalid fixtures must be rejected by each schema, so Python and TypeScript exercise the same structural boundary.

When contract fields change, update the relevant written specification, [schema](schemas/v5), [fixture](fixtures/v5), and [manifest](fixtures/v5/manifest.json) entries in this directory together.

## Fixture Usage

The fixtures under `fixtures/v5/` are executable examples of the current project-owned contract.

They are intentionally consumed by both the Python agents package and the GitHub integration package so the two implementations validate the same JSON shapes.

Package tests should read these fixtures through their local contract fixture helpers instead of hard-coding paths in individual tests:

- Python: `tests.contract_fixtures`
- TypeScript: `test/contract-fixtures.ts`

Schema validation tests should read `manifest.json` instead of maintaining package-local fixture maps.

## Artifact Boundary

Stage artifacts are runtime diagnostics unless a field is explicitly promoted into the public workflow result. Public results are `review_record`, repository `case_results[]`, repository `deliveries[]`, and the other fields documented in [CONTRACT_V5.md](CONTRACT_V5.md).

Callers should publish from the workflow result, not by reading whole stage artifact packages. If a stage artifact becomes necessary for caller behavior, either promote the required field into this contract or keep the dependency private to a local debugging tool.

## Change Checklist

For any contract change:

- update the relevant Markdown specification;
- update the JSON Schema in [schemas/v5](schemas/v5);
- update or add fixtures in [fixtures/v5](fixtures/v5);
- make both Python and TypeScript tests validate the same fixtures and schemas.
- keep [scripts/check_contracts.sh](../scripts/check_contracts.sh) aligned with the contract validation surface and run it before publishing the change.
