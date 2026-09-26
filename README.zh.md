<div align="center">

<img src="assets/sec-review-bot-logo.svg" alt="Sec Review Bot logo" width="120">

# Sec Review Bot

一个面向 GitHub issues、pull requests 和仓库级扫描的实验性安全审查 bot。

[![CI](https://github.com/Agent-AI-Chalmers/sec-review-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Agent-AI-Chalmers/sec-review-bot/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE) [![Python](https://img.shields.io/badge/Python-%E2%89%A53.14-3776AB?logo=python&logoColor=white)](agents/README.zh.md) [![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=node.js&logoColor=white)](apps/github-integration/README.zh.md)

[English](README.md) · 中文

[文档](docs/README.zh.md) · [部署](docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)

</div>

Sec Review Bot 支持使用 AI Agent 执行代码库安全审计，覆盖 issue、pull request、全仓扫描和增量扫描等安全审查任务。

## 能力

| 能力 | 行为 |
| --- | --- |
| Issue review | 审计 issue 报告，并在需要修复时产出经过复核的补丁或 draft PR。 |
| Pull request review | 审查 PR 变更，并可发布 review suggestions。 |
| Repository review | 对仓库执行全仓或增量扫描，并进行问题发现、筛选、逐项处理和交付规划。 |

## 运行结果示例

仓库级 review 会发布摘要，并生成对应的 draft PR：

<p align="center">
  <img src="assets/screenshots/repository-review-summary.png" alt="Repository review summary" width="720">
</p>

Draft PR 会包含修改文件、case 详情、analyzer / verifier 输出和补丁覆盖情况：

<p align="center">
  <img src="assets/screenshots/repository-delivery-pr.png" alt="Repository review delivery PR" width="720">
</p>

## 架构

这个仓库是一个 monorepo，主要有两个子系统：

- [`apps/github-integration/`](apps/github-integration/)：TS 编写，GitHub integration service，负责 GitHub App webhook、由 GitHub Actions 鉴权的 HTTP dispatch、输入材料准备和 GitHub 发布
- [`agents/src/sec_review_agents`](agents/src/sec_review_agents/)：Python 编写，multi-agent runner 和审查逻辑

`github-integration` 不直接调用 agents 代码，而是通过 HTTP 运行服务提交 run；运行服务再通过 Temporal 把任务交给 worker 执行。

## 运行技术栈

- GitHub integration：TypeScript / Node.js service，负责 GitHub App webhook、由 GitHub Actions 鉴权的 HTTP dispatch、输入材料准备和 GitHub 发布。
- Agent 运行后端：Python / FastAPI 服务加 Temporal worker。
- LangChain / LangGraph：agent 运行时，负责模型适配、结构化输出、工具调用和 workflow 内部的 agent loop。
- Langfuse：可选 tracing backend，用于 LLM 调用和 agent run 诊断。
- Temporal：长时间 agent run 的可靠执行层和任务队列（承担类似 RQ 的 job queue 角色），负责 workflow / activity 的调度、worker 分发、重试、超时和失败状态。
- Docker Compose：App、runner service 和 Temporal 的本地控制平面环境。
- 执行 worker：轮询 Temporal 并负责 Docker sandbox 执行的宿主机进程。
- Docker sandbox：agent 文件和命令工具的默认执行后端。

## 项目状态

本项目仍处于实验阶段，主要用于本地开发、集成测试和 workflow 研究。Runner 的公开契约有文档约束，但内部 package layout 和 agent workflow 仍可能调整。

Agent 的最终表现很大程度取决于底层 LLM 的代码理解、推理和补丁生成能力，也取决于输入质量和工具 / 运行时环境。本文中的 workflow 设计和运行链路不是独立于模型能力的固定性能保证。

## Agent 入口

如果只想看或运行 agent 侧，可以从这里开始：

- [Agents 本地运行说明](agents/README.zh.md)：Python 运行后端安装、能力、本地运行和运行边界。
- [LLM 配置](agents/README.zh.md#llm-配置) 和 [`agents/config/model-providers.sample.toml`](agents/config/model-providers.sample.toml)：模型 deployment 绑定。

## 支持的工作流

| 路径 | 触发方式 | 输出 |
| --- | --- | --- |
| Issue audit | `issues.opened`、`@<app-slug> review audit` | issue comment |
| Issue repair | `@<app-slug> review repair` | issue comment 或 draft PR |
| Pull request review | PR webhook、`@<app-slug> review` | PR review / suggestions |
| Repository review | 定时或手动触发的 GitHub Action | repository summary 和 deliveries |

完整触发行为见 [GitHub integration 触发说明](apps/github-integration/README.zh.md#触发)。

## 快速开始

### 本地启动完整链路

启动 GitHub integration、Runner Service 和 Temporal 控制平面：

```bash
cp compose.env.sample .env
cp agents/.env.sample agents/.env
cp agents/config/model-providers.sample.toml agents/config/model-providers.toml
cp apps/github-integration/.env.sample apps/github-integration/.env
# 填好 .env、agents/.env、agents/config/model-providers.toml、apps/github-integration/.env，
# 并把私钥放到 apps/github-integration/private-key.pem
docker compose --profile app up --build --force-recreate
```

然后在宿主机启动 `sec-review-agents-worker`。它轮询 Temporal，并使用宿主机 Docker daemon 可见的路径创建 Docker sandbox。前台运行和 systemd 常驻方式见[本地集成部署说明](docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)。

这套 Compose 是基于镜像的本地集成环境。修改 GitHub integration 或 Runner Service 代码后，需要重新运行这条命令来重建容器；它不是热更新开发循环。

如果不需要 GitHub integration，可不启用 `app` profile，只启动 `temporal` 和 `runner-service`；提交的 run 仍然需要宿主机 worker 才能执行。

验证运行服务：

```bash
RUNNER_SERVICE_TOKEN=<paste-your-token>
curl -sS http://127.0.0.1:8000/healthz \
  -H "Authorization: Bearer ${RUNNER_SERVICE_TOKEN}"
```

Compose 里的 Temporal Web UI 默认暴露在 `127.0.0.1:8233`；运行服务默认暴露在 `127.0.0.1:8000`，GitHub integration service 默认暴露在 `127.0.0.1:30000`。

## 从哪里开始

各 package 的安装和开发命令放在对应 package README 里。

| 目标 | 入口 |
| --- | --- |
| 本地启动完整链路和执行 worker | [本地集成部署说明](docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md) |
| 开发 GitHub integration | [GitHub integration 说明](apps/github-integration/README.zh.md) |
| 开发 agent 运行后端或做本地运行 | [Agents 本地运行说明](agents/README.zh.md) |
| 把 webhook 转发到本地 | [本地 webhook 设置](docs/operations/LOCAL_WEBHOOK_SETUP.zh.md) |

## 论文

本项目是以下硕士论文的配套代码仓库：

**Agentic AI Framework for Web Vulnerability Detection, Mitigation and Patching**  
Liu Xuanhao 和 Xie Jiangzhao，Chalmers University of Technology，2026。

[论文记录](https://hdl.handle.net/20.500.12380/311951)

```bibtex
@mastersthesis{liu2026agentic,
  title = {Agentic AI Framework for Web Vulnerability Detection, Mitigation and Patching},
  author = {Liu, Xuanhao and Xie, Jiangzhao},
  school = {Chalmers University of Technology},
  year = {2026},
  url = {https://hdl.handle.net/20.500.12380/311951}
}
```
