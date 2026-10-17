# 依赖维护

语言：[English](DEPENDENCY_MAINTENANCE.md) | 中文

本文是 [DEPENDENCY_MAINTENANCE.md](DEPENDENCY_MAINTENANCE.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文说明本仓库如何处理 GitHub integration、Python agents、GitHub Actions，以及运行时与工具链版本相关的更新。

## 策略

- 默认保持 lockfile 稳定。上游发布新版本，不应该让本地、CI 或部署行为自动漂移；只有经过审查的 manifest 或 lockfile 变更才应该改变依赖版本。
- 依赖更新要和其他变更分开。
- 直接依赖先看哪些代码导入了它。传递依赖先查是哪个包把它带进来的。
- 对安全问题、已知生产 bug 或高风险运行时依赖，使用定向更新。
- 只有在 dependency-only、resolver 有解、更新集合可理解，并且 package-local checks 通过时，才做完整 lockfile refresh。

Dependabot 配置在 [`.github/dependabot.yml`](../../.github/dependabot.yml)，管理 `npm`、`uv`、`pip` 和 GitHub Actions。Dependabot PR 是有用的更新探针，但 grouped PR 通常更新目标依赖，以及让这些目标能升级所需的 lockfile 变化；它不一定会把所有兼容的传递依赖都升到当前 resolver 能选到的最高版本。

## 审查本地依赖覆盖

依赖维护也包括为了弥补上游行为而存在的 wrapper、adapter、prompt 和工具描述覆盖。直接依赖发生变化时，要把每个本地覆盖与上游的新旧实现及其历史进行比较。一旦上游已经负责同一行为，就删除本地覆盖；否则，完整替换上游内容可能遮蔽后续修复，并悄然形成一份依赖契约的本地分叉。

Deep Agents 的 `grep` 描述就是一个例子。上游 0.6 时期的描述不足以阻止模型提交类似正则表达式的 pattern，并把因此产生的空匹配误当成证据，因此项目加入了明确的 literal-pattern 指引。后来 Deep Agents 增加了明确的 literal 指引、疑似正则误用时的恢复说明、感知 backend 能力的 `rg` fallback 指引，以及回归 eval。继续保留本地完整替换，反而会遮蔽 `max_count`、结果 offload 和感知能力的 fallback 等较新的上游说明，因此本地 `grep` 覆盖已被删除。项目特有的 `execute` 与 `read_file` 要求仍保留在本地，因为上游不负责这些策略。

## Node Packages (pnpm)

Node 包使用 `pnpm`，每个都有自己的 manifest 和 lockfile：

- `apps/github-integration/`
- `apps/control-plane-ui/`
- `control-plane/`
- `contracts/control-plane-api/tools/`
- `contracts/integration-contract/tools/`

| 目标 | 命令（在包目录中运行） |
| --- | --- |
| 检查过期依赖 | `pnpm outdated` |
| 在 manifest 范围内更新 | `pnpm update` |
| 本地检查 | `pnpm run lint`、`pnpm run typecheck`、`pnpm test` |

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

## RustFS Init

RustFS init 容器在 `ops/rustfs-init/` 下使用 `pip`；它唯一的依赖钉在 [`requirements.txt`](../../ops/rustfs-init/requirements.txt)。用 `pip list --outdated` 检查。

## GitHub Actions

action 以 major tag 固定在 `.github/workflows/`，由 Dependabot 的 `github-actions` 生态更新。把 major 升级当作行为变化，合并前先读 release notes。

## 运行时与工具链版本

当前声明：每个 TypeScript 包把 `engines.node` 钉在 `>=24 <25`，CI 通过 `node-version-file` 从 `package.json` 安装 Node，Dependabot 忽略 `typescript` 与 `@types/node` 的 semver-major。agents package 声明 `requires-python = ">=3.14"`，精确 patch 记在 `agents/.python-version`，CI 通过 `python-version-file` 安装 Python。

何时可以升级到下一个版本：

- Node 26：在它于 2026-10-28 成为 Active LTS 之后。
- Python 3.15：在我们要构建的原生扩展包发布 3.15 wheel 之后。3.15 已于 2026-10-09 发布，但其中若干仍是仅源码。
- TypeScript 7：在 `typescript-eslint` 接受它之后。其 peer 范围仍是 `>=4.8.4 <6.1.0`，tracking issue 仍为 open。

版本变更不是依赖更新：同步移动声明、CI 版本文件和任何 Dockerfile 基础镜像，然后重跑完整的本地检查。
