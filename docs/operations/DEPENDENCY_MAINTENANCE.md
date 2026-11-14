# Dependency Maintenance

Language: English | [中文](DEPENDENCY_MAINTENANCE.zh.md)

This page describes how this repository handles dependency updates for the GitHub Integration, Python agents, GitHub Actions, and runtime and toolchain versions.

## Policy

- Keep lockfiles stable by default. Upstream releases should not change local, CI, or deployment behavior until a manifest or lockfile change is reviewed.
- Keep dependency updates separate from other changes.
- For direct dependencies, check the code that imports them. For transitive dependencies, first find which package pulled them in.
- Use targeted updates for security findings, known production bugs, or high-risk runtime packages.
- Use full lockfile refreshes only for dependency-only changes when the resolver has a solution, the update set is understandable, and package-local checks pass.

Dependabot is configured in [`.github/dependabot.yml`](../../.github/dependabot.yml) for `npm`, `uv`, `pip`, and GitHub Actions. Dependabot PRs are useful update probes, but grouped PRs usually update target dependencies and the lockfile changes needed for those targets; they do not necessarily raise every compatible transitive dependency to the newest resolvable version.

## Review Local Dependency Overrides

Dependency maintenance also includes wrappers, adapters, prompts, and tool-description overrides that compensate for upstream behavior. When a direct dependency changes, compare each local override with the current upstream implementation and the behavior it originally supplied. Keep only project-specific behavior that upstream does not own; replacing an upstream contract locally can hide later fixes and create a silent fork.

> **Example: Deep Agents filesystem tools.** Deep Agents 0.7.26 already provides literal `grep` guidance, regex-miss recovery, backend-aware `rg` fallback, `max_count`, offloaded-result instructions, complete `read_file` pagination and result-shape guidance, and an `execute.timeout` schema with an explicit upper limit. This repository therefore uses the upstream tool descriptions and adds project-specific requirements in the agent prompt. For example, test success must be judged from the original command's exit status, not a successful trailing `grep`; this does not require rewriting the entire `execute` tool description.

## Node Packages (pnpm)

<!-- doc-default: node-workspace; source=pnpm-workspace.yaml -->

Node.js packages have individual `package.json` manifests and share the root pnpm workspace and `pnpm-lock.yaml`. See `pnpm-workspace.yaml` for the package list. Dependency changes update the shared root lockfile rather than creating package-local lockfiles.

| Goal                          | Command (run in a package directory)               |
| ----------------------------- | -------------------------------------------------- |
| Inspect outdated dependencies | `pnpm outdated`                                    |
| Update within manifest ranges | `pnpm update`                                      |
| Local checks                  | `pnpm run lint`, `pnpm run typecheck`, `pnpm test` |

## Python Agents

The agents package uses `uv` in `agents/`. Direct dependencies live in [`agents/pyproject.toml`](../../agents/pyproject.toml); resolved packages live in [`agents/uv.lock`](../../agents/uv.lock).

| Goal                                | Command                                     |
| ----------------------------------- | ------------------------------------------- |
| Inspect top-level outdated packages | `uv tree --outdated --all-groups --depth 1` |
| Preview a full lockfile refresh     | `uv lock --upgrade --dry-run`               |
| Apply a full lockfile refresh       | `uv lock --upgrade`                         |

Checks:

```bash
uv sync --group dev
uv run ruff check .
uv run black --check .
uv run mypy .
uv run pyright .
uv run python -m pytest
```

## RustFS Init

The RustFS init container uses `pip` in `ops/rustfs-init/`; its only dependency is pinned in [`requirements.txt`](../../ops/rustfs-init/requirements.txt). Check it with `pip list --outdated`.

## GitHub Actions

Actions are pinned by major tag in `.github/workflows/` and updated by Dependabot's `github-actions` ecosystem. Treat a major bump as a behavior change and read its release notes before merging.

## Runtime And Toolchain Versions

<!-- doc-default: node-runtime; source=package.json -->

Current declarations: every TypeScript package pins `engines.node` to `>=26.13.0 <27`, CI installs Node from `package.json` via `node-version-file`, and Dependabot ignores semver-major for `typescript` and `@types/node`. The agents package declares `requires-python = "==3.14.*"` with the exact patch in `agents/.python-version`, and CI installs Python via `python-version-file`.

When the next version can be adopted:

- TypeScript 7: once `typescript-eslint` accepts it. Its peer range is still `>=4.8.4 <6.1.0` and the tracking issue is open.

Review major upgrades separately. Update version declarations, CI version configuration, and relevant Dockerfile base images together, then run the complete checks; a lockfile-only update is insufficient.
