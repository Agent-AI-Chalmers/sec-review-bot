# 贡献指南

语言：[English](CONTRIBUTING.md) | 中文

本文是 [CONTRIBUTING.md](CONTRIBUTING.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

保持变更聚焦，维护明确的所有权边界，并验证实际消费该变更的 package 和 contract。本指南说明仓库级工作流程；各 package 和 contract 的 README 仍是本地细节的权威来源。

## 找到所有权边界

修改代码前，按以下顺序阅读维护文档：

1. 变更跨越服务、worker、存储或部署边界时，阅读[系统架构](docs/architecture/SYSTEM_ARCHITECTURE.zh.md)。
2. 阅读最近的 package 或目录 `README.md`，了解本地职责、设置、配置和命令；有中文版本时可以同时参考。
3. 阅读[文档地图](docs/README.zh.md)，查找 workflow、agent 和运维设计说明。
4. 对于跨 package 数据，在修改 schema、fixture、生成投影、artifact 或 API 形状之前，先阅读 [contracts 指南](contracts/README.zh.md)和受影响 contract family 的 README。

不要根据目录大小或文档长度推断所有权。即使多个运行角色共享同一个源码 package，它们也有明确的所有权边界。

## 准备变更

- 将某条路径视为废弃内容之前，搜索当前调用方、测试、生成产物的消费者、仓库脚本和注释。
- 让 patch 靠近所属边界。删除误导性的兼容层和虚假间接层，不要再次包装它们。
- 明确决定兼容性。破坏性变更必须识别受影响的调用方、artifact、持久化数据、配置或运维行为，并提供迁移路径。
- 职责、设置、配置、公开行为或运维流程发生变化时更新文档。按照[文档指南](docs/DOCUMENTATION_GUIDE.zh.md)使用耐久表述和易变事实 marker。
- 不要在未修改源文件、未运行所属生成器的情况下手工编辑生成产物。

## 验证受影响区域

在每个受影响的 package 中运行检查，不要只检查最先修改的 package。package README、`package.json` 或 `pyproject.toml` 定义准确的本地命令。

| 区域 | 开发指南 | 基线验证 |
| --- | --- | --- |
| Execution、Memory Extraction 和 Memory Maintenance Worker | [`agents/README.zh.md`](agents/README.zh.md) | Ruff、Black、mypy、Pyright、pytest |
| GitHub Integration | [`apps/github-integration/README.zh.md`](apps/github-integration/README.zh.md) | format、lint、typecheck、单元测试；数据库边界变化时运行集成测试 |
| Review Runs | [`review-runs/README.zh.md`](review-runs/README.zh.md) | format、lint、typecheck、测试、PostgreSQL 集成测试 |
| Control Plane UI | [`apps/control-plane-ui/README.zh.md`](apps/control-plane-ui/README.zh.md) | format、lint、typecheck、测试、build；用户可见流程运行浏览器 smoke test |
| Execution Gateway | [`execution-gateway/README.zh.md`](execution-gateway/README.zh.md) | format、lint、typecheck、测试、Temporal integration tests |
| Memory Catalog Server | [`memory-catalog/README.zh.md`](memory-catalog/README.zh.md) | format、lint、typecheck、测试、PostgreSQL integration tests |
| Execution submission 系统路径 | [`scripts/README.md`](scripts/README.md#system-test) | Review Runs client、Execution Gateway HTTP 与 Temporal 系统测试 |
| 仓库脚本 | [`scripts/README.md`](scripts/README.md) | Ruff、Black、compile 检查和聚焦的入口探针 |
| 文档 | [`docs/DOCUMENTATION_GUIDE.zh.md`](docs/DOCUMENTATION_GUIDE.zh.md) 和 [`docs/README.zh.md`](docs/README.zh.md) | 根据变更运行链接、wrapping 和译文标题检查 |

修改 contract 时，在 `contracts/<family>/tools/` 中运行受影响 family 的工具：重新生成投影，检查已提交 artifact 是否为最新，并运行格式化、lint、存在时的 contract lint、typecheck 和测试。随后运行消费方 package 的检查。参见 [contracts 变更检查清单](contracts/README.zh.md#变更检查清单)。

记录实际运行的命令和聚焦探针。明确说明相关缺口，不要暗示执行了更广泛的验证。

## 提交 Pull Request

### 标题

使用以下格式：

```text
<type>(<optional-scope>): <concise summary>
```

允许的 type 包括 `feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`build` 和 `ci`。只有 scope 能清楚标识主要所有者时才使用；破坏性变更在冒号前添加 `!`。

示例：

```text
refactor(agents): keep CVSS failure handling in scoring stage
fix(github-integration): preserve the review window after force push
docs: clarify runtime ownership
feat(contracts)!: remove legacy execution fields
```

描述主要结果，不要罗列所有修改区域。仓库会检查 pull request 标题是否符合该语法。

### 描述

遵循 [pull request 模板](.github/pull_request_template.md)：

- `Summary` 说明修改内容和原因。
- `Compatibility` 必须且只能选择 `No compatibility impact`、`Backward-compatible behavior change` 或 `Breaking change` 之一。破坏性变更必须说明受影响内容，以及调用方或运维人员应如何迁移。
- `Validation` 列出实际运行的检查、测试和聚焦探针，包括相关缺口。
- `Review Notes` 可选，只应包含有助于审核的信息，例如建议的审核顺序、不明显的权衡、有意保留的行为、排除范围、异常 artifact、不确定性或后续工作。

仓库会检查三个必填 section 是否存在且非空、`Compatibility` 是否恰好包含一种受支持分类，以及破坏性变更是否包含迁移指导。可以添加其他有助于审核的标题和 section，检查器不会解释它们。`Review Notes` 没有提供价值时应删除。

Dependabot pull request 保留其生成的依赖更新摘要、release note 和命令块，不使用人工编写的模板。它们仍需遵守标题规则、package 检查、审核和兼容性评估要求。
