# `sec-review-agents`

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`agents/` 是项目里的 Python 侧。它包含 runner 入口、workflow 执行、filesystem / workspace runtime、delivery 产物生成和 observability。

## 安装

在 `agents/` 目录运行：

```bash
uv sync --group dev
source .venv/bin/activate
```

本目录自带 `.python-version`；`pyproject.toml` 要求 Python 3.14 或更新版本。

> *Python 3.14 是当前 package 的默认开发、CI、package 和容器 runtime 基线。*

开发检查：

```bash
uv run ruff check .
uv run black --check .
uv run mypy .
uv run pyright .
uv run python -m pytest
```

本地清理时，可以让 ruff 应用安全的机械修复：

```bash
uv run ruff check . --fix
```

## LLM 配置

LLM 配置按 deployment 选择 provider。

这一层负责：

- 由 [`llm/config.py`](./src/sec_review_agents/llm/config.py) 读取 chat / embedding deployment 配置
- 由 [`llm/factory.py`](./src/sec_review_agents/llm/factory.py) 按 agent 选择 deployment
- 再按 provider 前缀构造原生 LangChain chat model
  - `openai/...` -> `ChatOpenAI`
  - `anthropic/...` -> `ChatAnthropic`
  - `google/...` -> `ChatGoogleGenerativeAI`

在本仓库里运行本地命令时，默认读取 `agents/.env` 和 `agents/config/model-providers.toml`。

本地 `run-local-*` CLI 和 `sec-review-agents-check-llm-deployments` 会加载 `agents/.env`，但不会覆盖进程里已有的环境变量。

`sec-review-agents-service` 和 `sec-review-agents-worker` 不会自己加载 `.env`。Compose 通过 `env_file` 注入 `agents/.env`；安装后运行、生产部署或手动启动时，应由 shell、supervisor 或 CI 先注入进程环境变量。

没有 `.env` 文件路径 override。`MODEL_PROVIDERS_CONFIG_TOML` 是模型配置路径的最高优先级入口；只有想把 TOML 放到其他位置，或运行方式不保留当前项目相对目录结构时，才需要显式设置它。

`[agent_deployment_bindings]` 用来把具体 agent 显式绑定到某个 deployment。所有运行到的 agent 都必须显式声明；未声明的 agent 会 fail fast，不会继承默认模型。

每个 `[[deployments]]` 都必须显式声明 `max_input_tokens`。runner 不会从 LangChain model profile 或 provider 名字推断上下文窗口；这个 deployment contract 才是上下文上限行为的事实来源。

## 能力

Python runner 支持：

- `issue-review` workflow
- issue analyzer / mitigator / verifier
- `pull-request-review` workflow
- PR analyzer / mitigator / verifier
- `repository-review` workflow
  - discovery / triage / analyzer / cvss-v4-scoring / mitigator / verifier / delivery
  - delivery 会把 repository cases 组织成可发布的交付结果；未交付 case 仍通过 case result 展示
- 本地评测 / ablation 路径：
  - `issue-review-two-stage`
  - `issue-review-single-agent`（local baseline）

resources 位于 package 内部：

- [`./src/sec_review_agents/resources/`](./src/sec_review_agents/resources/)
- runner 从这里读取 prompts，并把 agent 声明允许的 skills 准备好、挂给对应 agent 使用

## 目录

Python package 按职责读最清楚：

1. Agent implementations。
   - `agents/`：各类 agent 的提示词、运行配置、工具和输出结构。

2. Stage pipeline：共享执行、stage 产物和公开结果契约。
   - `scan_stages/`：repository discovery / triage stage execution，把仓库扫描信号整理成 cases。
   - `review_stages/`：analysis / mitigation / verification / CVSS stage execution、stage result payloads、review record projection 和 verifier feedback 逻辑。
   - `delivery_stages/`：repository delivery planning、delivery execution、patch synthesis execution 和 delivery result 生成。

3. Workflows：把 stage 组合成产品路径。
   - `workflows/`：`issue/`、`pull_request/`、`repository/` 是三个 public workflow；`repository_case/` 是 repository workflow 内部的单 case review。

4. Runner entrypoint：生产传输入口和输入准备。
   - `runner/`：FastAPI runner service、Temporal worker、workflow dispatch 和 workflow input preparation。

5. Runtime support：agent 运行所需基础设施。
   - `runtime/`、`filesystem/`、`workspace/`、`llm/`、`resources/`、`observability/`：agent runtime、filesystem sandbox、workspace 产物、模型配置、prompt / skill 资源和诊断支持。

## 本地运行

本地运行用于开发和调试，不是生产集成路径。

本地运行使用 `sec-review-agents-run-local-*` CLI。它们会通过 `cli/local_materialization/` 在本机准备 workspace snapshot、history 和 incremental window；runner 运行时再派生 artifacts 目录。这些准备工作只服务本地开发，不属于标准 HTTP service 入口的职责。

本地运行有两种执行模式：

- Direct local run：`run-local-*` 默认路径；最快，不需要 HTTP service，也不需要 Temporal。
- Local `--temporal` run：显式传 `--temporal`；不经过 HTTP service，但会跑内部 workflow / activity 编排。

local run 一概不参与 memory extraction 或 maintenance。

### 本地运行命令

安装依赖后，本地运行使用这些 `run-local-*` CLI：

- `sec-review-agents-run-local-issue`：本地 issue run 入口；可用 `--strategy default|two-stage|single-agent` 选择默认 multi-stage 路径、two-stage ablation 或 single-agent baseline
- `sec-review-agents-run-local-pr`：本地 PR run 入口
- `sec-review-agents-run-local-repository`：本地 repo 扫描 run 入口；可用 `--scan-mode full|incremental` 选择全量或增量扫描

这些命令默认使用 direct local execution。

---

本地运行默认使用临时目录保存 workflow result、workspace snapshot、history 和其他 artifacts。命令结束时会打印 `WORKFLOW_RESULT=...`，可根据该路径查看结果；也可以通过 `--output-dir` 指定固定的输出目录。

示例：

```bash
cd /path/to/monorepo
cp agents/.env.sample agents/.env
cp agents/config/model-providers.sample.toml agents/config/model-providers.toml

# 1) issue
sec-review-agents-run-local-issue \
  --repo /abs/path/to/repo \
  --issue-md /abs/path/to/issue.md \
  --target-branch main \
  --output-dir /abs/path/to/local-run

# 1b) issue two-stage ablation
sec-review-agents-run-local-issue \
  --repo /abs/path/to/repo \
  --issue-md /abs/path/to/issue.md \
  --target-branch main \
  --strategy two-stage

# 1c) issue single-agent baseline
sec-review-agents-run-local-issue \
  --repo /abs/path/to/repo \
  --issue-md /abs/path/to/issue.md \
  --target-branch main \
  --strategy single-agent

# 2) pr
sec-review-agents-run-local-pr \
  --repo /abs/path/to/repo \
  --pr-md /abs/path/to/pr.md \
  --base-sha <base-commit-sha> \
  --head-sha <head-commit-sha>

# 3) repo 全量扫描
sec-review-agents-run-local-repository \
  --repo /abs/path/to/repo \
  --target-branch main

# 4) repo 增量扫描
sec-review-agents-run-local-repository \
  --repo /abs/path/to/repo \
  --target-branch main \
  --scan-mode incremental \
  --base-sha <base-commit-sha> \
  --head-sha <head-commit-sha> # 可选，不填则自动取 target-branch 当前 head
```

### Direct local run

Direct local run 是上面这些命令的默认模式。它不需要 HTTP service，也不需要 Temporal。

### Local `--temporal` run

只有需要调试内部 Temporal workflow / activity 编排时，才使用 `--temporal`。

显式传 `--temporal` 时，同一个本地命令仍然在开发机上准备输入，但后续 workflow stages 会通过 Temporal workflow / activity 调度执行。这个模式适合调试 workflow 编排、retry、activity 边界或 Temporal 中可见的状态。它仍然绕过 HTTP Runner Service，因此不等同于完整 service path。

运行 `--temporal` local command 前，先启动本地 Temporal dev server：

```bash
temporal server start-dev --ip 127.0.0.1 --port 7233
```

然后另开一个 terminal，把 runner worker 作为宿主机进程启动：

```bash
cd agents
cp .env.sample .env
cp config/model-providers.sample.toml config/model-providers.toml
# 填好 .env 和 config/model-providers.toml

set -a
. .env
set +a

TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=default \
TEMPORAL_TASK_QUEUE=sec-review-agents \
sec-review-agents-worker
```

## Agent 运行时配置

Agent 可以声明自己需要的 skills。runner 启动 agent 时会自动准备并挂载声明的 skills。更多设计细节见 [Agent Skills](../docs/agent/SKILLS.zh.md)。

`AGENT_MEMORY_DIR` 用来指定 agent memory store。主 agent 会把其中的 `memory/` 子树挂载为 `/memory` 使用，其中 `memory/MEMORY.md` 会作为运行时参考。设置 `AGENT_MEMORY_ENABLED=false` 可以整套关闭 memory：主 agent 不再读取它，memory extraction 和 maintenance 也会停止。memory 里的内容来自历史 review transcripts，经过提炼和整理后供后续 review 复用。更多设计见 [Agent Memory System](../docs/agent/MEMORY_SYSTEM.zh.md)。

需要结构化输出的 agent 会检查最终 state 是否包含 `structured_response`。如果模型只返回普通文本、没有产出结构化结果，agent middleware 会在 LangChain agent loop 内追加一条纠偏消息并重试；重试次数由 `AGENT_MISSING_STRUCTURED_RESPONSE_MAX_RETRIES` 控制，默认 `2`。这层兜底独立于 provider/API 请求重试，不处理 schema 参数校验错误；参数校验错误仍交给 LangChain structured output 自身的 retry 机制。

## Sandbox 运行环境

agent 的正常运行环境优先是 Docker sandbox。本地 filesystem backend 是 fallback，主要用于 Docker 不可用或开发者显式关闭 sandbox 的场景。

默认策略：

- `AGENT_SANDBOX_BACKEND` 不设置或设置为 `auto`：自动探测 Docker，可用则使用
  Docker sandbox，不可用才退回本地 filesystem backend
- `AGENT_SANDBOX_BACKEND=docker`：强制 Docker sandbox
- `AGENT_SANDBOX_BACKEND=local`：显式使用本地 fallback

需要运行测试、reproduction、构建命令或可选运行时服务的 analyzer / mitigator / verifier，都应该在 Docker sandbox 下运行。本地 fallback 有意保持较多限制：它可以暴露挂载文件，支持有边界的读取和配置过的写入，但不应被当成完整运行时验证环境。

benchmark 和本地调试可以设置 `runtime.workspace_image`，指定承载目标代码库的隔离容器镜像。

### 可选 MCP 工具

MCP 在本项目里的定位见 [Agent MCP](../docs/agent/MCP.zh.md)。这里仅列本地常用的可选工具。

---

CodeGraph 能帮助 agent 做 symbol / caller tracing，比单纯 grep 更适合跨文件调用关系。Docker sandbox 下，先构建带 CodeGraph 的 workspace 镜像，再把它作为 sandbox 镜像，并开启 MCP：

```bash
docker build -f agents/docker/workspace-codegraph.Dockerfile -t sec-review-bot-workspace:codegraph agents
AGENT_DOCKER_IMAGE=sec-review-bot-workspace:codegraph
AGENT_MCP_ENABLED=true
```

正常阶段执行的 CodeGraph 正式路径是 Docker sandbox。

## 独立启动 Runner Service / Worker

需要本地验证 service / worker 路径时，可以直接启动 runner HTTP service 和 Temporal worker。

最小本地启动形状：

```bash
temporal server start-dev

# 使用真实本地 secret；runner 会消耗 LLM 配额。
export RUNNER_SERVICE_TOKEN="$(openssl rand -hex 32)"

TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_TASK_QUEUE=sec-review-agents \
sec-review-agents-service

TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_TASK_QUEUE=sec-review-agents \
sec-review-agents-worker
```

Service 负责 HTTP、鉴权、run request 校验和启动 Temporal workflow；worker 负责从 Temporal task queue 取 workflow / activity task 并调用 runner core。模型、sandbox、skills 和并发相关环境变量属于 service / worker 运行环境。

Docker Compose 启动 Temporal、service 和 worker 的说明见 [Docker Compose 部署](../docs/operations/DOCKER_COMPOSE_DEPLOYMENT.zh.md)；本文件只覆盖 runner 入口、本地 `run-local-*` CLI 和 agents 运行边界。
