# Docs

Language: English | [中文](README.zh.md)

This directory collects the project docs for `sec-review-bot`: agent design notes, public contracts, workflow design notes, and local operation guides.

For a project overview, start with the repository [README](../README.md).

## Documentation Map

### agent/

Use these docs when you need agent boundaries, capabilities, or framework decisions.

- [CAPABILITY_BOUNDARIES.md](agent/CAPABILITY_BOUNDARIES.md): Agent capability boundaries, including git-history and external-state limits.
- [SKILLS.md](agent/SKILLS.md): Agent skills selection, preparation, and mounting.
- [FRAMEWORK_SELECTION.md](agent/FRAMEWORK_SELECTION.md): Agent framework selection.
- [MEMORY_SYSTEM.md](agent/MEMORY_SYSTEM.md): Agent experience memory extraction and maintenance.
- [MCP.md](agent/MCP.md): Agent MCP tool boundary and runtime placement.
- [RELATED_ISSUES.md](agent/RELATED_ISSUES.md): Agent-related design issues.

### contracts/

`contracts/` holds the interfaces between components that cannot see each other's types: the App side, the Control Plane, and the Agent side. Each family keeps a specification, JSON Schemas, and fixtures, plus tests on both sides that fail the moment a shape drifts. A family that enforces less than that writes down what it does not cover.

One family covers one boundary:

| Family | Boundary | Sides |
| --- | --- | --- |
| [integration-contract](../contracts/integration-contract/README.md) | the Runner's HTTP surface and the workflow `input` / `result` data | Runner and its callers |
| [control-plane-api](../contracts/control-plane-api/README.md) | the run shapes the console reads, and the coordination record the integration exchanges over `POST /v1/store` | Control Plane and its callers |

Read [Contracts README](../contracts/README.md) first: it defines the family layout, the naming rule, what a schema owns, and how fixtures take part in validation. Each family README then states what a consumer may rely on, who owns which side, and what is deliberately not schematized.

- [integration-contract/v5/CONTRACT.md](../contracts/integration-contract/v5/CONTRACT.md): the workflow data contract.
- [integration-contract/openapi.json](../contracts/integration-contract/openapi.json): the Agent Runner HTTP API, generated from the service.
- [control-plane-api/v1/observed-run.schema.json](../contracts/control-plane-api/v1/observed-run.schema.json): the redacted run a console read returns.
- [control-plane-api/v1/review-run-record.schema.json](../contracts/control-plane-api/v1/review-run-record.schema.json): the record exchanged over `POST /v1/store`.

### workflows/

The main public workflow IDs are `issue-review`, `pull-request-review`, and `repository-review`. Issue and PR reviews run analysis, mitigation, and verification; repository review adds discovery, triage, CVSS scoring, and delivery planning.

#### Shared Review Rules

- [CONCURRENCY_MODEL.md](workflows/CONCURRENCY_MODEL.md): Workflow concurrency model.
- [NARRATIVE_FIRST_REVIEW.md](workflows/NARRATIVE_FIRST_REVIEW.md): Narrative-first analyzer output discipline.
- [REVIEW_INTENT.md](workflows/REVIEW_INTENT.md): Review intent and repair-stage constraints.
- [BOUNDED_VERIFIER_FEEDBACK_RETRY.md](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.md): Bounded verifier feedback retry.

#### issue-review

- [INPUT_PREANALYSIS.md](workflows/issue-review/INPUT_PREANALYSIS.md): Issue input pre-analysis.

#### pull-request-review

- [SUGGESTION_COMMENT_DESIGN.md](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.md): PR suggestion comment mapping rules.

#### repository-review

- [REPOSITORY_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.md): Repository review strategy and delivery boundaries.
- [DISCOVERY_AGENT_DESIGN.md](workflows/repository-review/DISCOVERY_AGENT_DESIGN.md): Discovery agent responsibilities, file selection, chunking, and resource boundaries.
- [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md): Incremental review strategy.
- [TRIAGE_BOUNDARIES.md](workflows/repository-review/TRIAGE_BOUNDARIES.md): Triage boundaries.
- [AGENT_PARTITION_WORKBENCH.md](workflows/repository-review/AGENT_PARTITION_WORKBENCH.md): Agent-edited partition workbench.
- [CVSSV4.md](workflows/repository-review/CVSSV4.md): CVSS v4 scoring.
- [CONCURRENCY_AND_FAILURES.md](workflows/repository-review/CONCURRENCY_AND_FAILURES.md): Repository review concurrency and failure boundaries.

### architecture/

- [SYSTEM_ARCHITECTURE.md](architecture/SYSTEM_ARCHITECTURE.md): Runtime entities, end-to-end data flow, cross-service contracts, sources of truth, and credential ownership.

### operations/

Use these docs when running the system locally or wiring GitHub webhooks:

- [DEPENDENCY_MAINTENANCE.md](operations/DEPENDENCY_MAINTENANCE.md): Dependency update policy, local inspection commands, and verification.
- [LOCAL_INTEGRATED_DEPLOYMENT.md](operations/LOCAL_INTEGRATED_DEPLOYMENT.md): Local control plane, host execution worker, systemd operation, and scaling.
- [LOCAL_GITHUB_INBOUND_SETUP.md](operations/LOCAL_GITHUB_INBOUND_SETUP.md): Route GitHub App webhooks and Actions repository review requests to a local service.

### roadmap/

- [FUTURE_WORK.md](roadmap/FUTURE_WORK.md): Future work.
