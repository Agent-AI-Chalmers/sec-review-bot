# 依赖维护

语言：[English](DEPENDENCY_MAINTENANCE.md) | 中文

本文为 [DEPENDENCY_MAINTENANCE.md](DEPENDENCY_MAINTENANCE.md) 的中文译文；如有差异，以英文版为准。

本文说明本仓库如何处理 GitHub Integration、Python Agent、GitHub Actions，以及运行时与工具链版本相关的更新。

## 策略

- 默认保持 lockfile 稳定。上游发布新版本，不应该让本地、CI 或部署行为自动漂移；只有经过审查的清单或 lockfile 变更才应该改变依赖版本。
- 依赖更新要和其他变更分开。
- 从实际用途出发。直接依赖要检查导入、包脚本、配置和部署路径；传递依赖先查由哪个上游包引入。先确认当前接入方式是否正常，再决定如何升级。
- 升级前先考虑能否删除。检查运行时或已有依赖是否已经提供所需行为，在验证替代方式后移除无用或重复的依赖。
- 在主要依赖的约束下，成套更新需要配合使用的包。不要独立强推传递依赖版本，也不要只更新相互配套的 API、SDK 或 exporter 中的一个组件。安全修复超出上游版本范围时，应明确评估兼容性变化，不能悄悄添加 override。
- 对安全问题、已知生产 bug 或高风险运行时依赖，使用定向更新。
- 只有在 dependency-only、resolver 有解、更新集合可理解，并且包内检查通过时，才做完整 lockfile refresh。

Dependabot 配置在 [`.github/dependabot.yml`](../../.github/dependabot.yml)，管理 `npm`、`uv`、`pip` 和 GitHub Actions。Dependabot PR 是有用的更新探针，但 grouped PR 通常更新目标依赖，以及让这些目标能升级所需的 lockfile 变化；它不一定会把所有兼容的传递依赖都升到当前 resolver 能选到的最高版本。

## 梳理依赖声明

依赖维护时，以及导入、脚本、构建步骤或部署路径变化后，都应及时核对依赖声明。删除过时条目，让每个依赖归属实际使用它的包和依赖分组。

- 部署后的应用需要的包应声明为运行时依赖。仅用于开发、测试、lint、类型检查或构建的工具应归入开发依赖；移动分组前，要核对实际安装和部署流程。
- 仓库代码直接导入或脚本直接调用的包，即使已被其他依赖间接引入，也应显式声明，不能依靠传递依赖碰巧可用。
- 不要仅为控制版本，就把上游包的内部依赖提升为直接依赖。没有直接使用方后，应移除直接声明，让上游包负责其传递依赖约束。

## 审查本地依赖覆盖

依赖维护也包括为了弥补上游行为而存在的 wrapper、adapter、提示词和工具描述覆盖。直接依赖发生变化时，要比较每个本地覆盖与当前上游实现，以及该覆盖原本提供的行为。只保留上游尚未负责的项目特有行为；完整替换上游契约可能遮蔽后续修复，并悄然形成一份本地分叉。

> **例：Deep Agents filesystem tools。** Deep Agents 0.7.26 已经提供 literal `grep` 指引、疑似正则误用后的恢复、感知 backend 能力的 `rg` fallback、`max_count`、结果 offload 说明、完整的 `read_file` 分页与结果形状说明，以及有上限的 `execute.timeout` schema。因此，本仓库沿用上游的工具描述，只在 Agent prompt 中补充项目自己的要求。例如，判断测试是否成功应看原始命令的退出状态，不能因为末尾的 `grep` 成功就认定测试成功；这不需要重写整个 `execute` 工具描述。

## Node.js 包（pnpm）

<!-- doc-default: node-workspace; source=pnpm-workspace.yaml -->

Node.js 包各自维护 `package.json`，并共用根目录的 pnpm 工作区和 `pnpm-lock.yaml`。包列表见 `pnpm-workspace.yaml`；依赖版本变更需要同步更新根目录的 lockfile，不为每个包另建 lockfile。

| 目标                                 | 命令（在包目录中运行）                             |
| ------------------------------------ | -------------------------------------------------- |
| 检查过期依赖                         | `pnpm outdated`                                    |
| 在 package.json 声明的版本范围内更新 | `pnpm update`                                      |
| 本地检查                             | `pnpm run lint`、`pnpm run typecheck`、`pnpm test` |

## Python Agent

Agents 包在 `agents/` 下使用 `uv`。直接依赖声明在 [`agents/pyproject.toml`](../../agents/pyproject.toml)，解析后的包锁在 [`agents/uv.lock`](../../agents/uv.lock)。

| 目标                      | 命令                                        |
| ------------------------- | ------------------------------------------- |
| 检查顶层过期包            | `uv tree --outdated --all-groups --depth 1` |
| 预览完整 lockfile refresh | `uv lock --upgrade --dry-run`               |
| 执行完整 lockfile refresh | `uv lock --upgrade`                         |

检查：

```bash
uv sync --group dev
uv run ruff check .
uv run black --check .
uv run mypy .
uv run pyright .
uv run python -m pytest
```

## RustFS 初始化

RustFS init 容器在 `ops/rustfs-init/` 下使用 `pip`；它唯一的依赖钉在 [`requirements.txt`](../../ops/rustfs-init/requirements.txt)。用 `pip list --outdated` 检查。

## GitHub Actions

action 以 major tag 固定在 `.github/workflows/`，由 Dependabot 的 `github-actions` 生态更新。把 major 升级当作行为变化，合并前先读 release notes。

## 运行时与工具链版本

<!-- doc-default: node-runtime; source=package.json -->

当前声明：每个 TypeScript 包把 `engines.node` 钉在 `>=26.13.0 <27`，CI 通过 `node-version-file` 从 `package.json` 安装 Node，Dependabot 忽略 `typescript` 与 `@types/node` 的 semver-major。agents 包声明 `requires-python = "==3.14.*"`，精确补丁版本记在 `agents/.python-version`，CI 通过 `python-version-file` 安装 Python。

<!-- doc-default: typescript-compiler; source=contracts/codegen/package.json -->

TypeScript 包使用原生 TypeScript 7 编译器。仓库的语法工具使用 Oxc，不依赖旧 TypeScript Compiler API。

大版本升级应单独审查。同步修改版本声明、CI 版本配置和相关 Dockerfile 基础镜像，再运行完整检查；不能只更新 lockfile。
