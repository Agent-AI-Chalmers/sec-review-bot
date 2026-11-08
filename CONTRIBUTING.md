# Contributing

Language: English | [中文](CONTRIBUTING.zh.md)

Keep each change focused on a concrete problem, keep component responsibilities clear, and check all affected packages and contracts. This guide explains the common contribution process. For installation, configuration, check commands, and contract-specific change requirements, read the README in the relevant directory.

## Find The Code Responsible For The Behavior

Before editing code, consult the documentation relevant to the change:

- Read the [system architecture](docs/architecture/SYSTEM_ARCHITECTURE.md) when the change crosses services, workers, storage, or deployment boundaries.
- Read the `README.md` in the directory containing the code you plan to change, or the nearest parent directory that has one. It explains what that code is responsible for, how to set it up and configure it, and which checks to run.
- If you need to change data exchanged between packages, first read the [contracts guide](contracts/README.md) and the README for the relevant contract. Identify which packages depend on these agreements and how the change would affect them.

Use the documented responsibilities and actual callers to determine who owns a change, rather than directory size or document length. Components in the same source package may still be responsible for different tasks.

## Guidelines For Making Changes

- Before deciding that code or a path is obsolete, look for its callers, related tests, repository scripts, and comments. If generated files are involved, also check where they are used.
- Prefer changing the code that implements the behavior.

  For example, suppose an HTTP endpoint and a CLI command use the same input-validation function. If that function accepts invalid input, fix the shared function so both entry points benefit, rather than adding a check only to the HTTP endpoint.
- Prefer removing an unnecessary intermediate layer over adding another wrapper.

  For example, consider `caller -> A() -> B()`. If `A()` only forwards arguments to `B()` and returns its result unchanged, with no other role such as validation, logging, or compatibility with an old interface, consider letting callers use `B()` directly. Check the callers first; if the old interface is still needed, do not simply delete `A()`. Handle any compatibility break as described below.
- State whether the change preserves compatibility. If it breaks compatibility, list the affected callers, artifacts, persisted data, configuration, or operational procedures and explain how to migrate.
- If a change affects component responsibilities, environment setup, configuration, public behavior, or operational steps, update the relevant documentation too.
- If you need to change a generated file, edit its source and run the corresponding generator. Do not edit the generated output directly.

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
| Cross-service system tests | [`system-tests/README.md`](system-tests/README.md) | Run the system tests relevant to the affected services and data flows |
| Repository scripts | [`scripts/README.md`](scripts/README.md) | Ruff, Black, Python syntax checks; check the changed scripts as appropriate, for example with `--help` or test inputs |
| Documentation | [`docs/DOCUMENTATION_GUIDE.md`](docs/DOCUMENTATION_GUIDE.md) and [`docs/README.md`](docs/README.md) | As applicable, check that local links work, prose paragraphs remain unwrapped as required, and English/Chinese heading structures match |

After changing a contract, complete the checks required by the [contracts guide](contracts/README.md) and the relevant contract README, then check all affected packages.

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
- `Validation` describes the checks and tests you ran, their results, and any relevant checks you did not run.
- `Review Notes` is optional and should contain only information that helps review, such as useful review order, non-obvious trade-offs, deliberately preserved behavior, excluded scope, unusual artifacts, uncertainties, or follow-up work.

The repository checks that the three required sections are present and non-empty, that `Compatibility` contains exactly one supported classification, and that a breaking change includes migration guidance. Additional headings and sections are welcome and are not interpreted by the check. Delete `Review Notes` when it adds no value.

Dependabot pull requests keep their generated dependency summary, release notes, and command block instead of using the human-authored template. They remain subject to the title rule, package checks, review, and compatibility assessment.
