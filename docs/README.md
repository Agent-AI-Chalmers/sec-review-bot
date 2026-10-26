# Docs

Language: English | [中文](README.zh.md)

This directory collects the project docs for `sec-review-bot`: agent design notes, public contracts, workflow design notes, and local operation guides.

For a project overview, start with the repository [README](../README.md).

## Documentation Map

### architecture/

- [SYSTEM_ARCHITECTURE.md](architecture/SYSTEM_ARCHITECTURE.md): Logical runtime roles, current deployment boundaries, ownership, and the main review and asynchronous memory paths.

### Packages and services

Package READMEs own local setup, commands, configuration, and implementation layout. Runtime roles and source packages are not one-to-one: `agents/` implements the Execution Worker, Memory Extraction Worker, and Memory Maintenance Worker.

| Runtime role | Package guide |
| --- | --- |
| GitHub Integration | [`apps/github-integration/README.md`](../apps/github-integration/README.md) |
| Review Runs | [`review-runs/README.md`](../review-runs/README.md) |
| Control Plane UI | [`apps/control-plane-ui/README.md`](../apps/control-plane-ui/README.md) |
| Execution Gateway | [`execution-gateway/README.md`](../execution-gateway/README.md) |
| Execution Worker | [`agents/README.md`](../agents/README.md) |
| Memory Extraction Worker | [`agents/README.md`](../agents/README.md) |
| Memory Maintenance Worker | [`agents/README.md`](../agents/README.md) |
| Memory Catalog Server | [`memory-catalog/README.md`](../memory-catalog/README.md) |

### agent/

Use these docs when you need agent boundaries, capabilities, or framework decisions.

- [CAPABILITY_BOUNDARIES.md](agent/CAPABILITY_BOUNDARIES.md): Agent capability boundaries, including git-history and external-state limits.
- [CONTEXT_DELIVERY.md](agent/CONTEXT_DELIVERY.md): Which context an agent receives in its prompt and which it reads on demand, and how each agent here chooses.
- [SKILLS.md](agent/SKILLS.md): Agent skills selection, preparation, and mounting.
- [FRAMEWORK_SELECTION.md](agent/FRAMEWORK_SELECTION.md): Agent framework selection.
- [MEMORY_SYSTEM.md](agent/MEMORY_SYSTEM.md): Agent experience memory extraction and maintenance.
- [EXTERNAL_TOOLS.md](agent/EXTERNAL_TOOLS.md): Agent external tools, CLI defaults, and optional MCP integrations.
- [RELATED_ISSUES.md](agent/RELATED_ISSUES.md): Agent-related design issues.

### contracts/

Read the [Contracts README](../contracts/README.md) for the canonical catalog of cross-package boundaries, their owners, versions, executable assets, and change procedure. Each family README then defines what consumers may rely on and what the contract deliberately leaves to domain code.

### workflows/

The main public workflow IDs are `issue-review`, `pull-request-review`, and `repository-review`. Issue and PR reviews run analysis, mitigation, and verification; repository review adds discovery, triage, CVSS scoring, and delivery planning.

#### Shared Review Rules

- [CONCURRENCY_MODEL.md](workflows/CONCURRENCY_MODEL.md): Workflow concurrency model.
- [NARRATIVE_FIRST_REVIEW.md](workflows/NARRATIVE_FIRST_REVIEW.md): Narrative-first analyzer output discipline.
- [REVIEW_INTENT.md](workflows/REVIEW_INTENT.md): Review intent and repair-stage constraints.
- [BOUNDED_VERIFIER_FEEDBACK_RETRY.md](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.md): Bounded verifier feedback retry.
- [TRUSTED_SETUP.md](workflows/TRUSTED_SETUP.md): Why setup declarations are shaped this way — the trust question, the constraints it yields, the decisions beyond trust, and the invariants.

#### issue-review

- [INPUT_PREANALYSIS.md](workflows/issue-review/INPUT_PREANALYSIS.md): Issue input pre-analysis.

#### pull-request-review

- [REVIEW_WINDOW_CONTRACT.md](workflows/pull-request-review/REVIEW_WINDOW_CONTRACT.md): Review window semantics for `synchronize`, measured GitHub API behavior, and the contract that keeps changed files, patch, and suggestion anchoring on one window.
- [SUGGESTION_COMMENT_DESIGN.md](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.md): PR suggestion comment mapping rules.

#### repository-review

- [REPOSITORY_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.md): Repository review strategy and delivery boundaries.
- [DISCOVERY_AGENT_DESIGN.md](workflows/repository-review/DISCOVERY_AGENT_DESIGN.md): Discovery agent responsibilities, file selection, chunking, and resource boundaries.
- [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md): Incremental review strategy.
- [TRIAGE_BOUNDARIES.md](workflows/repository-review/TRIAGE_BOUNDARIES.md): Triage boundaries.
- [AGENT_PARTITION_WORKBENCH.md](workflows/repository-review/AGENT_PARTITION_WORKBENCH.md): Agent-edited partition workbench.
- [CVSSV4.md](workflows/repository-review/CVSSV4.md): CVSS v4 scoring.
- [CONCURRENCY_AND_FAILURES.md](workflows/repository-review/CONCURRENCY_AND_FAILURES.md): Repository review concurrency and failure boundaries.

### operations/

Use these docs when running the system locally or wiring GitHub webhooks:

- [DEPENDENCY_MAINTENANCE.md](operations/DEPENDENCY_MAINTENANCE.md): Dependency update policy, local inspection commands, and verification.
- [LOCAL_INTEGRATED_DEPLOYMENT.md](operations/LOCAL_INTEGRATED_DEPLOYMENT.md): Local control plane, host execution worker, systemd operation, and scaling.
- [LOCAL_GITHUB_INBOUND_SETUP.md](operations/LOCAL_GITHUB_INBOUND_SETUP.md): Route GitHub App webhooks and Actions repository review requests to a local service.

### roadmap/

- [FUTURE_WORK.md](roadmap/FUTURE_WORK.md): Future work.
