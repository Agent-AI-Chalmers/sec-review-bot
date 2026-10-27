# 文档

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这里是 `sec-review-bot` 的项目文档入口，包含 agent 设计说明、public contracts、workflow 设计说明和本地运行指南。

如果想先看项目概览，从仓库根目录的 [README](../README.zh.md) 开始。

## 文档地图

### architecture/

- [SYSTEM_ARCHITECTURE.md](architecture/SYSTEM_ARCHITECTURE.md) / [中文](architecture/SYSTEM_ARCHITECTURE.zh.md)：逻辑运行角色、当前部署边界、职责所有权，以及主 review 与异步 memory 链路。

### Packages 与服务

Package README 负责本地 setup、命令、配置与实现布局。运行角色和源码 package 并非一一对应：`agents/` 实现 Execution Worker、Memory Extraction Worker 与 Memory Maintenance Worker。

| 运行角色 | Package 指南 |
| --- | --- |
| GitHub Integration | [`apps/github-integration/README.md`](../apps/github-integration/README.zh.md) |
| Review Runs | [`review-runs/README.md`](../review-runs/README.zh.md) |
| Control Plane UI | [`apps/control-plane-ui/README.md`](../apps/control-plane-ui/README.md) |
| Execution Gateway | [`execution-gateway/README.md`](../execution-gateway/README.zh.md) |
| Execution Worker | [`agents/README.md`](../agents/README.zh.md) |
| Memory Extraction Worker | [`agents/README.md`](../agents/README.zh.md) |
| Memory Maintenance Worker | [`agents/README.md`](../agents/README.zh.md) |
| Memory Catalog Server | [`memory-catalog/README.md`](../memory-catalog/README.zh.md) |

### agent/

需要理解 agent 边界、能力或 framework 取舍时，看这里。

- [CAPABILITY_BOUNDARIES.md](agent/CAPABILITY_BOUNDARIES.md) / [中文](agent/CAPABILITY_BOUNDARIES.zh.md)：Agent 能力边界，包括 git history 和外部状态限制。
- [CONTEXT_LOADING.md](agent/CONTEXT_LOADING.md) / [中文](agent/CONTEXT_LOADING.zh.md)：哪些上下文进 prompt、哪些由 agent 按需读取，以及本项目各 agent 如何选择。
- [SKILLS.md](agent/SKILLS.md) / [中文](agent/SKILLS.zh.md)：Agent skills 的选择、准备和挂载。
- [FRAMEWORK_SELECTION.md](agent/FRAMEWORK_SELECTION.md) / [中文](agent/FRAMEWORK_SELECTION.zh.md)：Agent framework 的选型。
- [MEMORY_SYSTEM.md](agent/MEMORY_SYSTEM.md) / [中文](agent/MEMORY_SYSTEM.zh.md)：Agent memory system、经验提取和整理。
- [EXTERNAL_TOOLS.md](agent/EXTERNAL_TOOLS.md) / [中文](agent/EXTERNAL_TOOLS.zh.md)：Agent 外部工具、默认 CLI 接入方式与可选 MCP 集成。
- [RELATED_ISSUES.md](agent/RELATED_ISSUES.md) / [中文](agent/RELATED_ISSUES.zh.md)：Agent 相关设计问题。

### contracts/

完整的跨 package 边界目录、所有者、版本、可执行资产与变更流程统一维护在 [Contracts README](../contracts/README.zh.md) 中。各契约族 README 再分别定义消费者可以依赖什么，以及哪些规则刻意留给领域代码。

### workflows/

主要 public workflow ID 是 `issue-review`、`pull-request-review` 和 `repository-review`。Issue / PR review 走 analysis、mitigation 和 verification；repository review 还包括 discovery、triage、CVSS scoring 和 delivery planning。

#### 共享 Review 规则

- [CONCURRENCY_MODEL.md](workflows/CONCURRENCY_MODEL.md) / [中文](workflows/CONCURRENCY_MODEL.zh.md)：Workflow 并发模型。
- [NARRATIVE_FIRST_REVIEW.md](workflows/NARRATIVE_FIRST_REVIEW.md) / [中文](workflows/NARRATIVE_FIRST_REVIEW.zh.md)：Narrative-first analyzer 输出纪律。
- [REVIEW_INTENT.md](workflows/REVIEW_INTENT.md) / [中文](workflows/REVIEW_INTENT.zh.md)：Review intent 和修复阶段约束。
- [BOUNDED_VERIFIER_FEEDBACK_RETRY.md](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.md) / [中文](workflows/BOUNDED_VERIFIER_FEEDBACK_RETRY.zh.md)：Verifier 反馈的有界重试。
- [TRUSTED_SETUP.md](workflows/TRUSTED_SETUP.md) / [中文](workflows/TRUSTED_SETUP.zh.md)：设置声明为何是这样——信任问题、它推出的约束、与信任无关的决定，以及不变量。

#### issue-review

- [INPUT_PREANALYSIS.md](workflows/issue-review/INPUT_PREANALYSIS.md) / [中文](workflows/issue-review/INPUT_PREANALYSIS.zh.md)：Issue input 的预分析。

#### pull-request-review

- [REVIEW_WINDOW_CONTRACT.md](workflows/pull-request-review/REVIEW_WINDOW_CONTRACT.md) / [中文](workflows/pull-request-review/REVIEW_WINDOW_CONTRACT.zh.md)：`synchronize` 的审查窗口语义、实测的 GitHub API 行为，以及让 changed files、patch 与 suggestion 锚定共用同一窗口的契约。
- [SUGGESTION_COMMENT_DESIGN.md](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.md) / [中文](workflows/pull-request-review/SUGGESTION_COMMENT_DESIGN.zh.md)：PR suggestion comment 映射规则。

#### repository-review

- [REPOSITORY_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.md) / [中文](workflows/repository-review/REPOSITORY_REVIEW_STRATEGY.zh.md)：Repository review 策略和 delivery 边界。
- [DISCOVERY_AGENT_DESIGN.md](workflows/repository-review/DISCOVERY_AGENT_DESIGN.md) / [中文](workflows/repository-review/DISCOVERY_AGENT_DESIGN.zh.md)：Discovery agent 的职责、文件选择、chunking 和资源边界。
- [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md) / [中文](workflows/repository-review/REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.zh.md)：Incremental review 策略。
- [TRIAGE_BOUNDARIES.md](workflows/repository-review/TRIAGE_BOUNDARIES.md) / [中文](workflows/repository-review/TRIAGE_BOUNDARIES.zh.md)：Triage 的边界。
- [AGENT_PARTITION_WORKBENCH.md](workflows/repository-review/AGENT_PARTITION_WORKBENCH.md) / [中文](workflows/repository-review/AGENT_PARTITION_WORKBENCH.zh.md)：Agent 直接编辑的分组工作台。
- [CVSSV4.md](workflows/repository-review/CVSSV4.md) / [中文](workflows/repository-review/CVSSV4.zh.md)：CVSS v4 评分。
- [CONCURRENCY_AND_FAILURES.md](workflows/repository-review/CONCURRENCY_AND_FAILURES.md) / [中文](workflows/repository-review/CONCURRENCY_AND_FAILURES.zh.md)：Repository review 并发与失败边界。

### operations/

本地运行系统或配置 GitHub webhook 时，看这里：

- [DEPENDENCY_MAINTENANCE.md](operations/DEPENDENCY_MAINTENANCE.md) / [中文](operations/DEPENDENCY_MAINTENANCE.zh.md)：依赖更新策略、本地检查命令和验证方式。
- [LOCAL_INTEGRATED_DEPLOYMENT.md](operations/LOCAL_INTEGRATED_DEPLOYMENT.md) / [中文](operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)：本地控制平面、宿主机执行 worker、systemd 运维和扩展方式。
- [LOCAL_GITHUB_INBOUND_SETUP.md](operations/LOCAL_GITHUB_INBOUND_SETUP.md) / [中文](operations/LOCAL_GITHUB_INBOUND_SETUP.zh.md)：将 GitHub App webhook 和 Actions 仓库级 review 请求转发到本地服务。

### roadmap/

- [FUTURE_WORK.md](roadmap/FUTURE_WORK.md) / [中文](roadmap/FUTURE_WORK.zh.md)：将来工作。
