# 贡献指南

语言：[English](CONTRIBUTING.md) | 中文

本文为 [CONTRIBUTING.md](CONTRIBUTING.md) 的中文译文；如有差异，以英文版为准。

每次修改应围绕明确的问题展开，保持各组件的职责清晰，并检查所有受影响的包和契约。本指南介绍通用的贡献流程。各包的安装、配置和检查命令，以及契约的修改要求，见对应目录的 README。

## 找到负责该功能的代码

修改代码前，根据修改涉及的内容查阅相关说明：

- 要改服务或 Worker 之间的调用、数据存储或部署配置，参阅[系统架构](docs/architecture/SYSTEM_ARCHITECTURE.zh.md)。
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

| 区域 | 开发指南 | 基本检查 |
| --- | --- | --- |
| Execution、Memory Extraction 和 Memory Maintenance Worker | [`agents/README.zh.md`](agents/README.zh.md) | Ruff、Black、mypy、Pyright、pytest |
| GitHub Integration | [`apps/github-integration/README.zh.md`](apps/github-integration/README.zh.md) | format、lint、typecheck、单元测试；数据库边界变化时运行集成测试 |
| Review Runs | [`services/review-runs/README.zh.md`](services/review-runs/README.zh.md) | format、lint、typecheck、测试、PostgreSQL 集成测试 |
| Control Plane UI | [`apps/control-plane-ui/README.zh.md`](apps/control-plane-ui/README.zh.md) | format、lint、typecheck、测试、build；涉及用户可见的界面或操作流程时，运行浏览器冒烟测试 |
| Execution Gateway | [`services/execution-gateway/README.zh.md`](services/execution-gateway/README.zh.md) | format、lint、typecheck、测试、Temporal 集成测试 |
| Memory Catalog Server | [`services/memory-catalog/README.zh.md`](services/memory-catalog/README.zh.md) | format、lint、typecheck、测试、PostgreSQL 集成测试 |
| 跨服务系统测试 | [`system-tests/README.md`](system-tests/README.md) | 根据修改涉及的服务和数据流，运行相关系统测试 |
| 仓库脚本 | [`scripts/README.md`](scripts/README.md) | Ruff、Black、Python 语法检查；根据修改内容，运行脚本的 `--help` 或用测试数据检查相关功能 |
| 文档 | [`docs/DOCUMENTATION_GUIDE.zh.md`](docs/DOCUMENTATION_GUIDE.zh.md) 和 [`docs/README.zh.md`](docs/README.zh.md) | 根据修改内容，检查本地链接是否有效、正文段落是否按要求不折行，以及中英文标题结构是否一致 |

修改契约后，按[契约指南](contracts/README.zh.md)和相关契约目录 README 的要求完成检查，并检查所有受影响的包。

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
- `Validation` 说明运行了哪些检查和测试、结果如何，以及哪些相关检查没有运行。
- `Review Notes` 可选，用来补充有助于审查本次修改的信息，例如建议先看哪些文件、为什么采用当前方案，或哪些工作留待以后处理。

PR 描述中的 `Summary`、`Compatibility` 和 `Validation` 不能为空；`Compatibility` 按模板保留选项，只勾选一项。可以添加其他有助于审查的章节。没有需要补充的内容时，删除 `Review Notes`。
