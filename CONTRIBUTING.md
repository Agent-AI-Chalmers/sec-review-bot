# Contributing

Language: English | [中文](CONTRIBUTING.zh.md)

Keep changes focused, preserve explicit ownership boundaries, and validate the packages and contracts that actually consume the change. This guide explains the common contribution process. For installation, configuration, check commands, and contract-specific change requirements, read the README in the relevant directory.

## Find The Owning Boundary

Before editing code, use the maintained documentation in this order:

1. Read the [system architecture](docs/architecture/SYSTEM_ARCHITECTURE.md) when the change crosses services, workers, storage, or deployment boundaries.
2. Read the nearest package or directory `README.md` for local responsibilities, setup, configuration, and commands.
3. Read the [documentation map](docs/README.md) for workflow, agent, and operations design notes.
4. For cross-package data, read the [contracts guide](contracts/README.md) and the affected contract-family README before changing a schema, fixture, generated projection, artifact, or API shape.

Use the documented responsibilities and actual callers to determine who owns a change, rather than directory size or document length. Components in the same source package may still be responsible for different tasks.

## Prepare A Change

- Search for current callers, tests, generated consumers, repository scripts, and comments before treating a path as obsolete.
- Keep the patch close to the owning boundary. Remove misleading compatibility and false indirection instead of wrapping them again.
- Decide compatibility explicitly. A breaking change must identify affected callers, artifacts, persisted data, configuration, or operational behavior and provide a migration path.
- Update documentation when responsibilities, setup, configuration, public behavior, or operational procedures change. Follow the [documentation guide](docs/DOCUMENTATION_GUIDE.md) for durable wording and mutable-fact markers.
- Do not hand-edit generated artifacts without changing their source and running the owning generator.

## Validate The Affected Areas

Run checks from every affected package, not only from the package where the first edit occurred. The package README and `package.json` or `pyproject.toml` define the exact local commands.

| Area | Development guide | Baseline validation |
| --- | --- | --- |
| Execution, Memory Extraction, and Memory Maintenance Workers | [`agents/README.md`](agents/README.md) | Ruff, Black, mypy, Pyright, pytest |
| GitHub Integration | [`apps/github-integration/README.md`](apps/github-integration/README.md) | format, lint, typecheck, unit tests; integration tests when the database boundary changes |
| Review Runs | [`services/review-runs/README.md`](services/review-runs/README.md) | format, lint, typecheck, tests, PostgreSQL integration tests |
| Control Plane UI | [`apps/control-plane-ui/README.md`](apps/control-plane-ui/README.md) | format, lint, typecheck, tests, build, browser smoke test for user-visible flows |
| Execution Gateway | [`services/execution-gateway/README.md`](services/execution-gateway/README.md) | format, lint, typecheck, tests, Temporal integration tests |
| Memory Catalog Server | [`services/memory-catalog/README.md`](services/memory-catalog/README.md) | format, lint, typecheck, tests, PostgreSQL integration tests |
| Execution submission system path | [`system-tests/README.md`](system-tests/README.md) | Review Runs client, Execution Gateway HTTP, and Temporal system test |
| Repository scripts | [`scripts/README.md`](scripts/README.md) | Ruff, Black, compile checks, and focused entrypoint probes |
| Documentation | [`docs/DOCUMENTATION_GUIDE.md`](docs/DOCUMENTATION_GUIDE.md) and [`docs/README.md`](docs/README.md) | link, wrapping, and translated-heading checks as applicable |

For a contract change, run the affected family tool from `contracts/<family>/tools/`: regenerate projections, check that committed artifacts are fresh, and run formatting, lint, contract lint when present, typechecking, and tests. Then run the consuming package checks. See the [contracts change checklist](contracts/README.md#change-checklist).

List the commands you ran to check the change and report the results. Also note any relevant checks you did not run.

## Submit A Pull Request

### Title

Use this format:

```text
<type>(<optional-scope>): <concise summary>
```

Allowed `type` values are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, and `ci`.

Use the optional `scope` to name the component being changed: `agents` in `fix(agents): ...`, for example. If no component needs naming, omit it and write `fix: ...`.

Add `!` before the colon for a breaking change.

Examples:

```text
refactor(agents): keep CVSS failure handling in scoring stage
fix(github-integration): preserve the review window after force push
docs: clarify runtime ownership
feat(contracts)!: remove legacy execution fields
```

Describe the primary result rather than listing every modified area. The repository checks this syntax on pull requests.

### Description

Follow [the pull request template](.github/pull_request_template.md):

- `Summary` explains what changed and why.
- `Compatibility` selects exactly one of `No compatibility impact`, `Backward-compatible behavior change`, or `Breaking change`. A breaking change must state what breaks and how callers or operators should migrate.
- `Validation` lists checks, tests, and focused probes actually run, including relevant gaps.
- `Review Notes` is optional and should contain only information that helps review, such as useful review order, non-obvious trade-offs, deliberately preserved behavior, excluded scope, unusual artifacts, uncertainties, or follow-up work.

The repository checks that the three required sections are present and non-empty, that `Compatibility` contains exactly one supported classification, and that a breaking change includes migration guidance. Additional headings and sections are welcome and are not interpreted by the check. Delete `Review Notes` when it adds no value.

Dependabot pull requests keep their generated dependency summary, release notes, and command block instead of using the human-authored template. They remain subject to the title rule, package checks, review, and compatibility assessment.
