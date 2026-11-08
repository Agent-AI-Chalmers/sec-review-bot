# 贡献指南

语言：[English](CONTRIBUTING.md) | 中文

本文是 [CONTRIBUTING.md](CONTRIBUTING.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

保持变更聚焦，维护明确的所有权边界，并验证实际消费该变更的 package 和 contract。本指南介绍通用的贡献流程。各包的安装、配置和检查命令，以及契约的修改要求，见对应目录的 README。

## 找到负责该功能的代码

修改代码前，根据修改涉及的内容查阅相关说明：

- 变更跨越服务、worker、存储或部署边界时，阅读[系统架构](docs/architecture/SYSTEM_ARCHITECTURE.zh.md)。
- 阅读准备修改的代码所在目录的 `README.md`；该目录没有时，向上查找最近一级目录的 README。通过它了解这部分代码负责什么、如何准备环境和配置，以及需要运行哪些检查。
- 如果需要修改多个包之间交换的数据，应先阅读[契约指南](contracts/README.zh.md)和相关契约目录的 README，确认哪些包依赖这些约定，以及修改会怎样影响它们。

判断由谁负责时，应看文档说明和实际调用关系，不能只看目录大小或文档篇幅。即使多个运行组件的代码放在同一个包中，它们也可能分别负责不同的任务。

## 修改时的注意事项

- 如果某段代码或某个路径看起来已经不用了，先查找调用方、相关测试、仓库脚本和注释，再判断它是否确实已经废弃。如果涉及生成文件，也要检查哪些地方还在使用这些文件。
- 优先修改实际负责该功能的代码。

  例如，HTTP 接口和命令行都调用同一个输入校验函数。如果这个函数会放过非法输入，就应修复这个公共函数，让两个入口都得到修复，而不是只在 HTTP 接口中补一道检查。
- 对没有必要的中间层，优先考虑移除，而不是继续加包装。

  例如，调用关系是 `调用方 -> A() -> B()`。如果 `A()` 只是把参数原样传给 `B()`，再原样返回结果，也不承担校验、日志记录或旧接口兼容等其他职责，就可以考虑让调用方直接调用 `B()`。删除前先检查调用方；如果仍需保留旧接口，就不能直接删掉 `A()`。涉及破坏性变更时，按下条要求处理。
- 明确说明是否保持兼容。破坏性变更必须列出受影响的调用方、产物、已保存的数据、配置或运维操作，并说明如何迁移。
- 如果修改改变了组件职责、环境准备方式、配置、对外行为或运维步骤，也要更新相应文档。
- 如果需要修改生成文件，应先修改其源文件，再运行对应的生成器，不要直接手改生成结果。

## 验证受影响区域

在每个受影响的包中运行检查，不要只检查直接改了代码的包。具体命令见各包的 README、`package.json` 或 `pyproject.toml`。

| 区域 | 开发指南 | 基线验证 |
| --- | --- | --- |
| Execution、Memory Extraction 和 Memory Maintenance Worker | [`agents/README.zh.md`](agents/README.zh.md) | Ruff、Black、mypy、Pyright、pytest |
| GitHub Integration | [`apps/github-integration/README.zh.md`](apps/github-integration/README.zh.md) | format、lint、typecheck、单元测试；数据库边界变化时运行集成测试 |
| Review Runs | [`services/review-runs/README.zh.md`](services/review-runs/README.zh.md) | format、lint、typecheck、测试、PostgreSQL 集成测试 |
| Control Plane UI | [`apps/control-plane-ui/README.zh.md`](apps/control-plane-ui/README.zh.md) | format、lint、typecheck、测试、build；涉及用户可见的界面或操作流程时，运行浏览器冒烟测试 |
| Execution Gateway | [`services/execution-gateway/README.zh.md`](services/execution-gateway/README.zh.md) | format、lint、typecheck、测试、Temporal 集成测试 |
| Memory Catalog Server | [`services/memory-catalog/README.zh.md`](services/memory-catalog/README.zh.md) | format、lint、typecheck、测试、PostgreSQL 集成测试 |
| Execution submission 系统路径 | [`system-tests/README.md`](system-tests/README.md) | Review Runs client、Execution Gateway HTTP 与 Temporal 系统测试 |
| 仓库脚本 | [`scripts/README.md`](scripts/README.md) | Ruff、Black、Python 语法检查；根据修改内容，运行脚本的 `--help` 或用测试数据检查相关功能 |
| 文档 | [`docs/DOCUMENTATION_GUIDE.zh.md`](docs/DOCUMENTATION_GUIDE.zh.md) 和 [`docs/README.zh.md`](docs/README.zh.md) | 根据变更运行链接、wrapping 和译文标题检查 |

修改 contract 时，在 `contracts/<family>/tools/` 中运行受影响 family 的工具：重新生成投影，检查已提交 artifact 是否为最新，并运行格式化、lint、存在时的 contract lint、typecheck 和测试。随后运行消费方 package 的检查。参见 [contracts 变更检查清单](contracts/README.zh.md#变更检查清单)。

列出你实际运行的检查命令，并说明结果。如果还有与本次修改有关的检查没有运行，也要写清楚。

## 提交 Pull Request

### 标题

使用以下格式：

```text
<type>(<optional-scope>): <concise summary>
```

允许的 `type` 包括 `feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`build` 和 `ci`。

如果需要在标题中注明修改的组件，可以填写 `scope`，例如 `fix(agents): ...` 中的 `agents`。不需要注明时就省略，写成 `fix: ...`。

破坏性变更在冒号前添加 `!`。

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
