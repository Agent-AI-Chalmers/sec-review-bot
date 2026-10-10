# 文档

语言：[English](README.md) | 中文

这里是 `sec-review-bot` 的项目文档入口，包含 agent 设计说明、public contracts、workflow 设计说明和本地运行指南。

如果想先看项目概览，从仓库根目录的 [README](../README.zh.md) 开始。

## 文档地图

### agent/

需要理解 agent 边界、能力或 framework 取舍时，看这里。

- [CAPABILITY_BOUNDARIES.md](agent/CAPABILITY_BOUNDARIES.md) / [中文](agent/CAPABILITY_BOUNDARIES.zh.md)：Agent 能力边界，包括 git history 和外部状态限制。
- [SKILLS.md](agent/SKILLS.md) / [中文](agent/SKILLS.zh.md)：Agent skills 的选择、准备和挂载。
- [FRAMEWORK_SELECTION.md](agent/FRAMEWORK_SELECTION.md) / [中文](agent/FRAMEWORK_SELECTION.zh.md)：Agent framework 的选型。
- [MEMORY_SYSTEM.md](agent/MEMORY_SYSTEM.md) / [中文](agent/MEMORY_SYSTEM.zh.md)：Agent memory system、经验提取和整理。
- [MCP.md](agent/MCP.md) / [中文](agent/MCP.zh.md)：Agent MCP 工具边界和运行位置。
- [RELATED_ISSUES.md](agent/RELATED_ISSUES.md) / [中文](agent/RELATED_ISSUES.zh.md)：Agent 相关设计问题。

### contracts/

`contracts/` 记录的是那些**彼此看不到对方类型**的组件之间的接口：App 侧、Control Plane、Agent 侧。每个族各留一份规范、JSON Schema、fixtures，以及**形状一变就会在两侧失败**的测试。执行得比这少的族，会写明自己没覆盖什么。

一个族对应一条边界：

| 族 | 边界 | 两侧 |
| --- | --- | --- |
| [integration-contract](../contracts/integration-contract/README.zh.md) | Runner 的 HTTP 面，以及 workflow 的 `input` / `result` 数据 | Runner 与它的调用方 |
| [control-plane-api](../contracts/control-plane-api/README.zh.md) | 控制台读取的运行形状，以及集成方经 `POST /v1/store` 交换的协调记录 | Control Plane 与它的调用方 |

先读 [Contracts README](../contracts/README.zh.md)：它定义了族目录的布局、命名规则、schema 该拥有什么，以及 fixtures 如何参与校验。各族 README 再分别说明消费者可以依赖什么、哪一侧归谁、以及哪些是刻意不做成 schema 的。

- [integration-contract/v5/CONTRACT.md](../contracts/integration-contract/v5/CONTRACT.md) / [中文](../contracts/integration-contract/v5/CONTRACT.zh.md)：workflow 数据契约。
- [integration-contract/openapi.json](../contracts/integration-contract/openapi.json)：Agent Runner HTTP API，由服务代码生成。
- [control-plane-api/v1/observed-run.schema.json](../contracts/control-plane-api/v1/observed-run.schema.json)：控制台读取返回的脱敏运行形状。
- [control-plane-api/v1/review-run-record.schema.json](../contracts/control-plane-api/v1/review-run-record.schema.json)：经 `POST /v1/store` 交换的记录。

### workflows/

主要 public workflow ID 是 `issue-review`、`pull-request-review` 和 `repository-review`。Issue / PR review 走 analysis、mitigation 和 verification；repository review 还包括 discovery、triage、CVSS scoring 和 delivery planning。

#### 共享 Review 规则

- [CONCURRENCY_MODEL.md](workflows/CONCURRENCY_MODEL.md) / [中文](workflows/CONCURRENCY_MODEL.zh.md)：Workflow 并发模型。
- [NARRATIVE_FIRST_REVIEW.md](workflows/NARRATIVE_FIRST_REVIEW.md) / [中文](workflows/NARRATIVE_FIRST_REVIEW.zh.md)：Narrative-first analyzer 输出纪律。
- [REVIEW_INTENT.md](workflows/REVIEW_INTENT.md) / [中文](workflows/REVIEW_INTENT.zh.md)：Review intent 和修复阶段约束。
- [BOUNDED_VERIFIER_FEEDBACK_RETRY.md](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.md) / [中文](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.zh.md)：Bounded verifier feedback retry。

#### issue-review

- [INPUT_PREANALYSIS.md](workflows/issue-review/INPUT_PREANALYSIS.md) / [中文](workflows/issue-review/INPUT_PREANALYSIS.zh.md)：Issue input pre-analysis。

#### pull-request-review

- [SUGGESTION_COMMENT_DESIGN.md](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.md) / [中文](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.zh.md)：PR suggestion comment 映射规则。

#### repository-review

- [REPOSITORY_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.md) / [中文](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.zh.md)：Repository review 策略和 delivery 边界。
- [DISCOVERY_AGENT_DESIGN.md](workflows/repository-review/DISCOVERY_AGENT_DESIGN.md) / [中文](workflows/repository-review/DISCOVERY_AGENT_DESIGN.zh.md)：Discovery agent 的职责、文件选择、chunking 和资源边界。
- [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md) / [中文](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.zh.md)：Incremental review 策略。
- [TRIAGE_BOUNDARIES.md](workflows/repository-review/TRIAGE_BOUNDARIES.md) / [中文](workflows/repository-review/TRIAGE_BOUNDARIES.zh.md)：Triage boundaries。
- [AGENT_PARTITION_WORKBENCH.md](workflows/repository-review/AGENT_PARTITION_WORKBENCH.md) / [中文](workflows/repository-review/AGENT_PARTITION_WORKBENCH.zh.md)：Agent-edited partition workbench。
- [CVSSV4.md](workflows/repository-review/CVSSV4.md) / [中文](workflows/repository-review/CVSSV4.zh.md)：CVSS v4 scoring。
- [CONCURRENCY_AND_FAILURES.md](workflows/repository-review/CONCURRENCY_AND_FAILURES.md) / [中文](workflows/repository-review/CONCURRENCY_AND_FAILURES.zh.md)：Repository review 并发与失败边界。

### architecture/

- [SYSTEM_ARCHITECTURE.md](architecture/SYSTEM_ARCHITECTURE.md) / [中文](architecture/SYSTEM_ARCHITECTURE.zh.md)：运行实体、端到端数据流、跨服务契约、事实来源和凭据所有权。

### operations/

本地运行系统或配置 GitHub webhook 时，看这里：

- [DEPENDENCY_MAINTENANCE.md](operations/DEPENDENCY_MAINTENANCE.md) / [中文](operations/DEPENDENCY_MAINTENANCE.zh.md)：依赖更新策略、本地检查命令和验证方式。
- [LOCAL_INTEGRATED_DEPLOYMENT.md](operations/LOCAL_INTEGRATED_DEPLOYMENT.md) / [中文](operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)：本地控制平面、宿主机执行 worker、systemd 运维和扩展方式。
- [LOCAL_GITHUB_INBOUND_SETUP.md](operations/LOCAL_GITHUB_INBOUND_SETUP.md) / [中文](operations/LOCAL_GITHUB_INBOUND_SETUP.zh.md)：将 GitHub App webhook 和 Actions 仓库级 review 请求转发到本地服务。

### roadmap/

- [FUTURE_WORK.md](roadmap/FUTURE_WORK.md) / [中文](roadmap/FUTURE_WORK.zh.md)：将来工作。
