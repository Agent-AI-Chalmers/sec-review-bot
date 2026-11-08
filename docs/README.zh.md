# 文档

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

这里汇总 `sec-review-bot` 的 Agent 设计、对外接口与数据格式、工作流和本地运行说明。

如果想先看项目概览，从仓库根目录的 [README](../README.zh.md) 开始。

## 按任务选择阅读路线

| 你想做什么 | 建议顺序 |
| --- | --- |
| 在本地运行一次审查 | [Agents 安装与模型配置](../agents/README.zh.md) → [本地运行示例](../agents/README.zh.md#本地运行)；无需先部署 GitHub 集成。 |
| 部署 GitHub 审查服务 | [LOCAL_INTEGRATED_DEPLOYMENT](operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md) → [LOCAL_GITHUB_INBOUND_SETUP](operations/LOCAL_GITHUB_INBOUND_SETUP.zh.md) → [触发命令](../apps/github-integration/README.zh.md#触发)。 |
| 修改 Agent 或工作流 | [STAGE_AGENT_OWNERSHIP](architecture/STAGE_AGENT_OWNERSHIP.zh.md) → [README](../agents/README.zh.md) → 对应工作流文档。 |
| 修改服务间接口或产物格式 | [SYSTEM_ARCHITECTURE](architecture/SYSTEM_ARCHITECTURE.zh.md) → [契约目录](../contracts/README.zh.md) → 对应契约目录和使用方的说明。 |
| 开发控制台界面 | [Control Plane UI](../apps/control-plane-ui/README.zh.md)，先用测试数据预览，无需启动完整后端。 |

下面的目录用于按主题查阅，不要求从头读到尾。

## 文档目录

- [DOCUMENTATION_GUIDE](DOCUMENTATION_GUIDE.zh.md)：关于耐久表述、易变事实、翻译和文档审核的仓库级规则。

### 架构

- [SYSTEM_ARCHITECTURE](architecture/SYSTEM_ARCHITECTURE.zh.md)：各运行组件的职责、部署方式，以及审查执行和异步记忆处理的数据流。
- [STAGE_AGENT_OWNERSHIP](architecture/STAGE_AGENT_OWNERSHIP.zh.md)：阶段与 Agent 分别负责什么，以及临时工作区、连接和 MCP 会话由谁创建、何时关闭。

### 包与服务

各包的 README 说明安装、命令、配置和代码结构。一个源码包可以实现多个独立运行的组件，例如 `agents/` 实现 Execution Worker、Memory Extraction Worker 与 Memory Maintenance Worker。

| 运行角色 | 包说明 |
| --- | --- |
| GitHub Integration | [README](../apps/github-integration/README.zh.md) |
| Review Runs | [README](../services/review-runs/README.zh.md) |
| Control Plane UI | [README](../apps/control-plane-ui/README.zh.md) |
| Execution Gateway | [README](../services/execution-gateway/README.zh.md) |
| Execution Worker | [README](../agents/README.zh.md) |
| Memory Extraction Worker | [README](../agents/README.zh.md) |
| Memory Maintenance Worker | [README](../agents/README.zh.md) |
| Memory Catalog Server | [README](../services/memory-catalog/README.zh.md) |

### Agent

需要理解 agent 边界、能力或 framework 取舍时，看这里。

- [CAPABILITY_BOUNDARIES](agent/CAPABILITY_BOUNDARIES.zh.md)：Agent 能力边界，包括 Git 历史和仓库外状态的处理限制。
- [agent-transcript](../contracts/agent-transcript/README.zh.md)：JSONL 消息、执行关系与用量核算。
- [CONTEXT_LOADING](agent/CONTEXT_LOADING.zh.md)：哪些内容直接放进提示词，哪些由 Agent 按需读取，以及各类 Agent 采用哪种方式。
- [SKILLS](agent/SKILLS.zh.md)：Agent 技能的选择、准备和挂载。
- [FRAMEWORK_SELECTION](agent/FRAMEWORK_SELECTION.zh.md)：Agent 框架的选择及理由。
- [MEMORY_SYSTEM](agent/MEMORY_SYSTEM.zh.md)：Agent 如何读取记忆，以及如何提取和整理审查经验。
- [EXTERNAL_TOOLS](agent/EXTERNAL_TOOLS.zh.md)：Agent 外部工具、默认 CLI 接入方式与可选 MCP 集成。
- [RELATED_ISSUES](agent/RELATED_ISSUES.zh.md)：Agent 相关设计问题。

### 契约

包与包之间交换哪些数据、由谁维护、使用哪个版本，以及如何校验和修改，见[契约目录说明](../contracts/README.zh.md)。每类契约的 README 进一步说明接口保证什么、调用方还需自行处理哪些规则。

### 工作流

主要 public workflow ID 是 `issue-review`、`pull-request-review` 和 `repository-review`。Issue / PR review 走 analysis、mitigation 和 verification；repository review 还包括 discovery、triage、CVSS scoring 和 delivery planning。

#### 通用审查规则

- [CONCURRENCY_MODEL](workflows/CONCURRENCY_MODEL.zh.md)：工作流如何控制并发。
- [NARRATIVE_FIRST_REVIEW](workflows/NARRATIVE_FIRST_REVIEW.zh.md)：为什么采用 narrative-first（叙事为先），以及 Analyzer、Mitigator 和 Verifier 如何围绕 narrative 组织和使用证据与结论。
- [REVIEW_INTENT](workflows/REVIEW_INTENT.zh.md)：`review_intent` 如何指定审查目标，并约束最终补丁中的测试改动。
- [BOUNDED_VERIFIER_FEEDBACK_RETRY](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.zh.md)：何时根据 Verifier 的反馈重新执行修复和验证、重试时传递哪些上下文，以及如何限制重试次数。
- [TRUSTED_SETUP](workflows/TRUSTED_SETUP.zh.md)：为什么从默认分支读取环境准备步骤、审查 fork PR 时为何需要授权，以及这些步骤如何在沙箱中执行。

#### Issue 审查

- [INPUT_PREANALYSIS](workflows/issue-review/INPUT_PREANALYSIS.zh.md)：如何根据 Issue 中的线索开始调查，避免过早相信报告或无目的地扩大调查范围。

#### PR 审查

- [REVIEW_WINDOW_CONTRACT](workflows/pull-request-review/REVIEW_WINDOW_CONTRACT.zh.md)：变更文件列表、补丁和行内修改建议如何使用同一 PR 审查窗口。
- [SUGGESTION_COMMENT_DESIGN](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.zh.md)：如何将修复补丁映射为 GitHub PR review comment 中的 suggestion 代码块。

#### 仓库审查

- [REPOSITORY_REVIEW_STRATEGY](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.zh.md)：仓库审查各阶段的职责，以及如何组织可交付的修复。
- [DISCOVERY_AGENT_DESIGN](workflows/repository-review/DISCOVERY_AGENT_DESIGN.zh.md)：Discovery Agent 的职责、文件选择、分块方式和资源限制。
- [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.zh.md)：增量审查如何选择扫描文件、处理删除和限定审查窗口。
- [TRIAGE_BOUNDARIES](workflows/repository-review/TRIAGE_BOUNDARIES.zh.md)：Triage 阶段何时保留、合并或排除候选线索。
- [AGENT_PARTITION_WORKBENCH](workflows/repository-review/AGENT_PARTITION_WORKBENCH.zh.md)：Agent 直接编辑的分组工作台。
- [CVSSV4](workflows/repository-review/CVSSV4.zh.md)：CVSS v4 评分。
- [CONCURRENCY_AND_FAILURES](workflows/repository-review/CONCURRENCY_AND_FAILURES.zh.md)：仓库审查如何并发执行，以及局部失败会影响哪些任务。

### 运维

本地运行系统或配置 GitHub webhook 时，看这里：

- [DEPENDENCY_MAINTENANCE](operations/DEPENDENCY_MAINTENANCE.zh.md)：依赖更新策略、本地检查命令和验证方式。
- [LOCAL_INTEGRATED_DEPLOYMENT](operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)：本地控制平面、宿主机执行 Worker、systemd 运维和扩展方式。
- [LOCAL_MEMORY_DEVELOPMENT](operations/LOCAL_MEMORY_DEVELOPMENT.zh.md)：如何搭建本地 Memory 开发环境、启动 Worker 和执行维护操作。
- [LOCAL_GITHUB_INBOUND_SETUP](operations/LOCAL_GITHUB_INBOUND_SETUP.zh.md)：将 GitHub App webhook 和 GitHub Actions 发起的仓库审查请求转发到本地服务。

### 后续工作

- [FUTURE_WORK](roadmap/FUTURE_WORK.zh.md)：将来工作。
