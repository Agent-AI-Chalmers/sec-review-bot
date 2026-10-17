# Dependency Maintenance

Language: English | [中文](DEPENDENCY_MAINTENANCE.zh.md)

This page describes how this repository handles dependency updates for the GitHub integration, Python agents, GitHub Actions, and runtime and toolchain versions.

## Policy

- Keep lockfiles stable by default. Upstream releases should not change local, CI, or deployment behavior until a manifest or lockfile change is reviewed.
- Keep dependency updates separate from other changes.
- For direct dependencies, check the code that imports them. For transitive dependencies, first find which package pulled them in.
- Use targeted updates for security findings, known production bugs, or high-risk runtime packages.
- Use full lockfile refreshes only for dependency-only changes when the resolver has a solution, the update set is understandable, and package-local checks pass.

Dependabot is configured in [`.github/dependabot.yml`](../../.github/dependabot.yml) for `npm`, `uv`, `pip`, and GitHub Actions. Dependabot PRs are useful update probes, but grouped PRs usually update target dependencies and the lockfile changes needed for those targets; they do not necessarily raise every compatible transitive dependency to the newest resolvable version.

## Review Local Dependency Overrides

Dependency maintenance also includes wrappers, adapters, prompts, and tool-description overrides that compensate for upstream behavior. When a direct dependency changes, compare each local override with both the old and current upstream implementation and history. Delete an override once upstream owns the same behavior; a full local replacement can otherwise hide later fixes and create a silent fork of the dependency contract.

The Deep Agents `grep` description was one such case. The project added explicit literal-pattern guidance when the 0.6-era upstream description did not adequately prevent models from submitting regex-like patterns and interpreting the resulting empty matches as evidence. Deep Agents later added explicit literal guidance, recovery instructions for likely regex misses, backend-aware `rg` fallback guidance, and regression evaluations. Keeping the local replacement then hid newer upstream guidance such as `max_count`, offloaded results, and capability-aware fallback behavior, so the local `grep` override was deleted. The project-specific `execute` and `read_file` requirements remain local because upstream does not own those policies.

## Node Packages (pnpm)

The Node packages use `pnpm`, each with its own manifest and lockfile:

- `apps/github-integration/`
- `apps/control-plane-ui/`
- `control-plane/`
- `contracts/control-plane-api/tools/`
- `contracts/integration-contract/tools/`

| Goal | Command (run in a package directory) |
| --- | --- |
| Inspect outdated dependencies | `pnpm outdated` |
| Update within manifest ranges | `pnpm update` |
| Local checks | `pnpm run lint`, `pnpm run typecheck`, `pnpm test` |

## Python Agents

The agents package uses `uv` in `agents/`. Direct dependencies live in [`agents/pyproject.toml`](../../agents/pyproject.toml); resolved packages live in [`agents/uv.lock`](../../agents/uv.lock).

| Goal | Command |
| --- | --- |
| Inspect top-level outdated packages | `uv tree --outdated --all-groups --depth 1` |
| Preview a full lockfile refresh | `uv lock --upgrade --dry-run` |
| Apply a full lockfile refresh | `uv lock --upgrade` |

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

Current declarations: every TypeScript package pins `engines.node` to `>=24 <25`, CI installs Node from `package.json` via `node-version-file`, and Dependabot ignores semver-major for `typescript` and `@types/node`. The agents package declares `requires-python = ">=3.14"` with the exact patch in `agents/.python-version`, and CI installs Python via `python-version-file`.

When the next version can be adopted:

- Node 26: after it becomes Active LTS on 2026-10-28.
- Python 3.15: once the native-extension packages we build against publish 3.15 wheels. 3.15 shipped on 2026-10-09 but several are still source-only.
- TypeScript 7: once `typescript-eslint` accepts it. Its peer range is still `>=4.8.4 <6.1.0` and the tracking issue is open.

A version change is not a dependency update: move the declaration, the CI version file, and any Dockerfile base image together, then re-run the full local checks.
