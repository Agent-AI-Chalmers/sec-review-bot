# 依赖维护

语言：[English](DEPENDENCY_MAINTENANCE.md) | 中文

本文是 [DEPENDENCY_MAINTENANCE.md](DEPENDENCY_MAINTENANCE.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文说明本仓库如何处理 GitHub integration、Python agents、GitHub Actions，以及 Node / Python 版本策略相关的更新。

## 策略

- 默认保持 lockfile 稳定。上游发布新版本，不应该让本地、CI 或部署行为自动漂移；只有经过审查的 manifest 或 lockfile 变更才应该改变依赖版本。
- 依赖更新要和其他变更分开。
- 直接依赖先看哪些代码导入了它。传递依赖先查是哪个包把它带进来的。
- 对安全问题、已知生产 bug 或高风险运行时依赖，使用定向更新。
- 只有在 dependency-only、resolver 有解、更新集合可理解，并且 package-local checks 通过时，才做完整 lockfile refresh。

Dependabot 配置在 [`.github/dependabot.yml`](../../.github/dependabot.yml)，管理 `npm`、`uv` 和 GitHub Actions。Dependabot PR 是有用的更新探针，但 grouped PR 通常更新目标依赖，以及让这些目标能升级所需的 lockfile 变化；它不一定会把所有兼容的传递依赖都升到当前 resolver 能选到的最高版本。

## GitHub Integration

GitHub integration package 在 `apps/github-integration/` 下使用 `pnpm`。

| 目标 | 命令 |
| --- | --- |
| 检查过期依赖 | `pnpm outdated` |
| 在 manifest 范围内更新 | `pnpm update` |

检查：

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```

## Python Agents

Agents package 在 `agents/` 下使用 `uv`。直接依赖声明在 [`agents/pyproject.toml`](../../agents/pyproject.toml)，解析后的包锁在 [`agents/uv.lock`](../../agents/uv.lock)。

| 目标 | 命令 |
| --- | --- |
| 检查顶层过期包 | `uv tree --outdated --all-groups --depth 1` |
| 预览完整 lockfile refresh | `uv lock --upgrade --dry-run` |
| 执行完整 lockfile refresh | `uv lock --upgrade` |

检查：

```bash
uv sync --group dev
uv run ruff check .
uv run black --check .
uv run mypy .
uv run pyright .
uv run python -m pytest
```
