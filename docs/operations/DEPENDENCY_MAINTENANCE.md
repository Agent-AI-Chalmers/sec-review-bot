# Dependency Maintenance

Language: English | [中文](DEPENDENCY_MAINTENANCE.zh.md)

This page describes how this repository handles dependency updates for the GitHub integration, Python agents, GitHub Actions, and Node / Python version policy.

## Policy

- Keep lockfiles stable by default. Upstream releases should not change local, CI, or deployment behavior until a manifest or lockfile change is reviewed.
- Keep dependency updates separate from other changes.
- For direct dependencies, check the code that imports them. For transitive dependencies, first find which package pulled them in.
- Use targeted updates for security findings, known production bugs, or high-risk runtime packages.
- Use full lockfile refreshes only for dependency-only changes when the resolver has a solution, the update set is understandable, and package-local checks pass.

Dependabot is configured in [`.github/dependabot.yml`](../../.github/dependabot.yml) for `npm`, `uv`, and GitHub Actions. Dependabot PRs are useful update probes, but grouped PRs usually update target dependencies and the lockfile changes needed for those targets; they do not necessarily raise every compatible transitive dependency to the newest resolvable version.

## GitHub Integration

The GitHub integration package uses `pnpm` in `apps/github-integration/`.

| Goal | Command |
| --- | --- |
| Inspect outdated dependencies | `pnpm outdated` |
| Update within manifest ranges | `pnpm update` |

Checks:

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```

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
