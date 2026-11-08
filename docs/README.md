# Docs

Language: English | [中文](README.zh.md)

This directory collects the project docs for `sec-review-bot`: agent design notes, public contracts, workflow design notes, and local operation guides.

For a project overview, start with the repository [README](../README.md).

## Reading Paths By Task

| Task | Suggested order |
| --- | --- |
| Run one local review | [Agents installation and model setup](../agents/README.md) → [local run examples](../agents/README.md#local-runs); GitHub integration is not required. |
| Deploy GitHub reviews | [LOCAL_INTEGRATED_DEPLOYMENT](operations/LOCAL_INTEGRATED_DEPLOYMENT.md) → [LOCAL_GITHUB_INBOUND_SETUP](operations/LOCAL_GITHUB_INBOUND_SETUP.md) → [trigger commands](../apps/github-integration/README.md#triggers). |
| Change an agent or workflow | [STAGE_AGENT_OWNERSHIP](architecture/STAGE_AGENT_OWNERSHIP.md) → [README](../agents/README.md) → the relevant workflow document. |
| Change a service interface or artifact format | [SYSTEM_ARCHITECTURE](architecture/SYSTEM_ARCHITECTURE.md) → [contracts catalog](../contracts/README.md) → the family and consumer guides. |
| Develop the console | [Control Plane UI](../apps/control-plane-ui/README.md); start with fixtures without deploying the full backend. |

The catalog below is a reference, not a required reading sequence.

## Documentation Index

- [DOCUMENTATION_GUIDE](DOCUMENTATION_GUIDE.md): Repository-wide rules for durable wording, mutable facts, translations, and documentation review.

### Architecture

- [SYSTEM_ARCHITECTURE](architecture/SYSTEM_ARCHITECTURE.md): Logical runtime roles, current deployment boundaries, ownership, and the main review and asynchronous memory paths.
- [STAGE_AGENT_OWNERSHIP](architecture/STAGE_AGENT_OWNERSHIP.md): Stage and agent responsibilities, resource lifetimes, and MCP session ownership.

### Packages and services

Package READMEs explain installation, commands, configuration, and code layout. One source package can implement several independently running components: `agents/` implements the Execution Worker, Memory Extraction Worker, and Memory Maintenance Worker.

| Runtime role | Package guide |
| --- | --- |
| GitHub Integration | [README](../apps/github-integration/README.md) |
| Review Runs | [README](../services/review-runs/README.md) |
| Control Plane UI | [README](../apps/control-plane-ui/README.md) |
| Execution Gateway | [README](../services/execution-gateway/README.md) |
| Execution Worker | [README](../agents/README.md) |
| Memory Extraction Worker | [README](../agents/README.md) |
| Memory Maintenance Worker | [README](../agents/README.md) |
| Memory Catalog Server | [README](../services/memory-catalog/README.md) |

### Agents

Use these docs when you need agent boundaries, capabilities, or framework decisions.

- [CAPABILITY_BOUNDARIES](agent/CAPABILITY_BOUNDARIES.md): Agent capability boundaries, including git-history and external-state limits.
- [agent-transcript](../contracts/agent-transcript/README.md): JSONL messages, execution relationships, and usage accounting.
- [CONTEXT_LOADING](agent/CONTEXT_LOADING.md): Which context an agent receives in its prompt and which it reads on demand, and how each agent here chooses.
- [SKILLS](agent/SKILLS.md): Agent skills selection, preparation, and mounting.
- [FRAMEWORK_SELECTION](agent/FRAMEWORK_SELECTION.md): Agent framework selection.
- [MEMORY_SYSTEM](agent/MEMORY_SYSTEM.md): Agent experience memory extraction and maintenance.
- [EXTERNAL_TOOLS](agent/EXTERNAL_TOOLS.md): Agent external tools, CLI defaults, and optional MCP integrations.
- [RELATED_ISSUES](agent/RELATED_ISSUES.md): Agent-related design issues.

### Contracts

The [Contracts README](../contracts/README.md) lists the data exchanged between packages, who maintains it, its versions, and how to validate and change it. Each family README explains the interface guarantees and the rules callers must handle themselves.

### Workflows

The main public workflow IDs are `issue-review`, `pull-request-review`, and `repository-review`. Issue and PR reviews run analysis, mitigation, and verification; repository review adds discovery, triage, CVSS scoring, and delivery planning.

#### Shared Review Rules

- [CONCURRENCY_MODEL](workflows/CONCURRENCY_MODEL.md): Workflow concurrency model.
- [NARRATIVE_FIRST_REVIEW](workflows/NARRATIVE_FIRST_REVIEW.md): Narrative-first analyzer output discipline.
- [REVIEW_INTENT](workflows/REVIEW_INTENT.md): Review intent and repair-stage constraints.
- [BOUNDED_VERIFIER_FEEDBACK_RETRY](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.md): Bounded verifier feedback retry.
- [TRUSTED_SETUP](workflows/TRUSTED_SETUP.md): Why setup declarations are shaped this way — the trust question, the constraints it yields, the decisions beyond trust, and the invariants.

#### Issue Review

- [INPUT_PREANALYSIS](workflows/issue-review/INPUT_PREANALYSIS.md): Issue input pre-analysis.

#### Pull Request Review

- [REVIEW_WINDOW_CONTRACT](workflows/pull-request-review/REVIEW_WINDOW_CONTRACT.md): Review window semantics for `synchronize`, measured GitHub API behavior, and the contract that keeps changed files, patch, and suggestion anchoring on one window.
- [SUGGESTION_COMMENT_DESIGN](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.md): PR suggestion comment mapping rules.

#### Repository Review

- [REPOSITORY_REVIEW_STRATEGY](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.md): Repository review strategy and delivery boundaries.
- [DISCOVERY_AGENT_DESIGN](workflows/repository-review/DISCOVERY_AGENT_DESIGN.md): Discovery agent responsibilities, file selection, chunking, and resource boundaries.
- [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md): Incremental review strategy.
- [TRIAGE_BOUNDARIES](workflows/repository-review/TRIAGE_BOUNDARIES.md): Triage boundaries.
- [AGENT_PARTITION_WORKBENCH](workflows/repository-review/AGENT_PARTITION_WORKBENCH.md): Agent-edited partition workbench.
- [CVSSV4](workflows/repository-review/CVSSV4.md): CVSS v4 scoring.
- [CONCURRENCY_AND_FAILURES](workflows/repository-review/CONCURRENCY_AND_FAILURES.md): Repository review concurrency and failure boundaries.

### Operations

Use these docs when running the system locally or wiring GitHub webhooks:

- [DEPENDENCY_MAINTENANCE](operations/DEPENDENCY_MAINTENANCE.md): Dependency update policy, local inspection commands, and verification.
- [LOCAL_INTEGRATED_DEPLOYMENT](operations/LOCAL_INTEGRATED_DEPLOYMENT.md): Local control plane, host execution worker, systemd operation, and scaling.
- [LOCAL_MEMORY_DEVELOPMENT](operations/LOCAL_MEMORY_DEVELOPMENT.md): Standalone local Memory infrastructure, worker startup, and maintenance operations.
- [LOCAL_GITHUB_INBOUND_SETUP](operations/LOCAL_GITHUB_INBOUND_SETUP.md): Route GitHub App webhooks and Actions repository review requests to a local service.

### Future Work

- [FUTURE_WORK](roadmap/FUTURE_WORK.md): Future work.
