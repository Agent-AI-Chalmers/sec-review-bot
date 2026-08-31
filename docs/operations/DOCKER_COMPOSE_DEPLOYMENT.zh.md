# Docker Compose 部署

语言：[English](DOCKER_COMPOSE_DEPLOYMENT.md) | 中文

本文是 [DOCKER_COMPOSE_DEPLOYMENT.md](DOCKER_COMPOSE_DEPLOYMENT.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这是完整 GitHub integration / 运行服务 / runner worker / Temporal 的本地部署说明。

如果你要在本地跑完整集成链路，读本文。不经过 HTTP 运行服务、直接在本地运行 agent，或使用 `run-local-* --temporal` 调试时，见 [agents 本地运行说明](../../agents/README.zh.md)。

## 本地链路

这套 Compose 把生产链路需要的几个进程放在同一台开发机上：GitHub integration 接收 GitHub webhook 或由 GitHub Actions 鉴权的 HTTP dispatch，准备 runner input bundle，然后把 run 提交给 Runner Service。Runner Service 通过 Temporal 启动 workflow，Runner Worker 执行 activity，并在需要文件或命令工具时使用 Docker sandbox。

Compose 中的服务对应关系：

- `github-integration`：GitHub 平台入口、input bundle 准备、GitHub 发布
- `runner-service`：HTTP runner API，负责接收 run submission 并启动 Temporal workflow
- `runner-worker`：Temporal worker，执行 workflow activity
- `temporal`：本地 Temporal server 和 task queue

默认本地端口：

| Service | URL |
| --- | --- |
| GitHub integration | `http://127.0.0.1:30000` |
| Runner Service | `http://127.0.0.1:8000` |
| Temporal Web UI | `http://127.0.0.1:8233` |

## 必要文件

在仓库根目录运行：

```bash
cp compose.env.sample .env
cp agents/.env.sample agents/.env
cp agents/config/model-providers.sample.toml agents/config/model-providers.toml
cp apps/github-integration/.env.sample apps/github-integration/.env
```

然后填好：

- `agents/.env`
- `agents/config/model-providers.toml`
- `apps/github-integration/.env`

GitHub App 私钥放在：

```text
apps/github-integration/private-key.pem
```

Compose 会把 `agents/config/model-providers.toml` 作为 secret 挂到运行服务和 worker；不要跳过。

## 本地路径

Compose 使用三个本地状态目录：

| Path | Owner | Purpose |
| --- | --- | --- |
| `.agent-input-bundles` | GitHub integration 写入，runner 读取 | 准备好的 runner 输入材料 |
| `.agent-artifacts` | Runner service / worker | 每次运行的 agent 产物和 workflow 输出 |
| `.agent-app-state` | GitHub integration | 后台发布流程使用的 submitted-run state |

关键路径规则：从仓库根目录启动 Docker Compose。input bundle 路径在 GitHub integration 容器、worker 容器和宿主 Docker daemon 眼里必须是同一个绝对路径。artifact 路径归 runner 所有，必须按 Docker sandbox 执行时使用的同一个宿主机路径挂进 worker 容器。

## 环境变量

这里有三层配置，分别落在三个文件里。

### 1. Compose `.env`

Compose 层默认值在 [compose.env.sample](../../compose.env.sample)。这个文件只管 Compose 怎么启动容器、挂载哪些本地目录、暴露哪些端口。要覆盖默认值，启动 Compose 前复制成仓库根目录的 `.env`。

常用路径配置：

```bash
RUNNER_SERVICE_TOKEN=<用 openssl rand -hex 32 生成>
SEC_REVIEW_INPUT_BUNDLE_ROOT=${PWD}/.agent-input-bundles
SEC_REVIEW_AGENT_ARTIFACT_ROOT=${PWD}/.agent-artifacts
SEC_REVIEW_APP_STATE_ROOT=${PWD}/.agent-app-state
```

### 2. GitHub integration `.env`

GitHub integration 运行配置见 [apps/github-integration/.env.sample](../../apps/github-integration/.env.sample)。本地最小配置：

```bash
APP_ID=123456
PRIVATE_KEY_PATH=/absolute/path/to/private-key.pem
WEBHOOK_SECRET=your_webhook_secret
PORT=30000
AGENT_RUNNER_SERVICE_URL=http://127.0.0.1:8000
AGENT_RUNNER_SERVICE_TOKEN=<与 RUNNER_SERVICE_TOKEN 相同>
```

Compose 会覆盖容器内私钥路径和运行服务地址。

### 3. Agents 配置

Agents 侧配置见 [agents/.env.sample](../../agents/.env.sample)。模型 deployment 配置见 [agents/config/model-providers.sample.toml](../../agents/config/model-providers.sample.toml)。

所有运行到的 agent 都必须显式绑定模型 deployment：

```toml
[[deployments]]
name = "anthropic_strong"
model = "anthropic/claude-3-7-sonnet-20250219"
max_input_tokens = 200000
api_key = "your_anthropic_key"
api_base = "https://your-anthropic-endpoint/v1"

[agent_deployment_bindings]
issue-analyzer = "anthropic_strong"
```

修改模型配置或凭据后，可以探测 deployment 可用性：

```bash
cd agents
sec-review-agents-check-llm-deployments
sec-review-agents-check-llm-deployments --fail-fast
```

## GitHub App 设置

需要的 repository permissions：

- `Pull requests: Read and write`
- `Contents: Read and write`
- `Issues: Read and write`

需要订阅的 webhook：

- `Pull request`
- `Issues`
- `Issue comment`

补充：

- `Metadata: Read-only` 是 GitHub App 默认权限，不需要手动额外开启。
- 如果修改了 App 权限，已有 installation 往往需要重新批准权限。
- 权限不够时，常见报错是 `403 Resource not accessible by integration`。

如果要把公网 URL 转发到本地 GitHub integration service，见 [本地 webhook 设置](LOCAL_WEBHOOK_SETUP.zh.md)。

## 仓库级 Review Dispatch

仓库级 review 通过 [`.github/workflows/sec-review-bot.yml`](../../.github/workflows/sec-review-bot.yml) 的 `workflow_dispatch` 或 `schedule` 触发。

目标仓库需要配置这些 Actions secrets：

```bash
SEC_BOT_DISPATCH_URL=https://your-bot-dev.example.com/api/repository-review/dispatch
```

Repository review workflow 使用 GitHub Actions OIDC 向 App 鉴权。workflow 必须配置 `id-token: write`，OIDC audience 固定为 `sec-review-bot`。

## 启动

完整本地集成：

```bash
docker compose --profile app up --build
```

这会启动 GitHub integration service、运行服务、runner worker 和 Temporal。

这套 Compose 是基于镜像的本地集成环境。修改 GitHub integration 或 agents 代码后，重建相关容器：

```bash
docker compose --profile app up --build --force-recreate
```

它不是热更新开发循环。

只启动运行后端：

```bash
docker compose up --build temporal runner-service runner-worker
```

验证运行服务：

```bash
RUNNER_SERVICE_TOKEN=<paste-your-token>
curl -sS http://127.0.0.1:8000/healthz \
  -H "Authorization: Bearer ${RUNNER_SERVICE_TOKEN}"
```

## 可选运行控制

Langfuse tracing：

```bash
LANGFUSE_PUBLIC_KEY=your_public_key
LANGFUSE_SECRET_KEY=your_secret_key
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Runtime diagnostics：

```bash
AGENT_LOG_LEVEL=INFO
AGENT_MODEL_TURN_DIAGNOSTICS=1
AGENT_GRAPH_MAX_STEPS=24
AGENT_GRAPH_RECURSION_BUFFER=8
```

Repository workflow 并发：

```bash
AGENT_DISCOVERY_MAX_CONCURRENCY=1
AGENT_CASE_PROCESSING_MAX_CONCURRENCY=1
```

并发值只限制同时在飞请求数，不等价于 TPM/RPM 限流控制；是否触发配额更取决于 token 体积、请求速率和重试行为。

Docker sandbox：

```bash
AGENT_SANDBOX_BACKEND=docker
AGENT_DOCKER_IMAGE=mcr.microsoft.com/devcontainers/universal:6-noble
AGENT_DOCKER_NETWORK_MODE=none
```

Compose 默认策略是 `auto`：Docker 可用则使用 Docker sandbox，不可用才退回本地 filesystem backend。

Docker sandbox 下的可选 CodeGraph MCP：

```bash
docker build -f agents/docker/workspace-codegraph.Dockerfile -t sec-review-bot-workspace:codegraph agents
AGENT_DOCKER_IMAGE=sec-review-bot-workspace:codegraph
AGENT_MCP_ENABLED=true
```

本地 fallback 下，需要在 host `PATH` 上安装 `codegraph`，并设置 `AGENT_MCP_ENABLED=true`。CodeGraph tools 只会挂到显式 opt in、并且暴露可写 `/workspace` 的阶段。

## 清理

Compose 采用最简单的权限模型：App、worker 和 sandbox 都按容器默认 root 用户运行。代价是本地 bundle / artifact 目录可能留下 root-owned 文件。

可用下面命令修复 ownership：

```bash
sudo chown -R "$USER:$USER" .agent-input-bundles .agent-artifacts .agent-app-state
```

确认不需要保留 run 后也可以直接删除：

```bash
sudo rm -rf .agent-input-bundles .agent-artifacts .agent-app-state
```

## 排障

- `403 Resource not accessible by integration`：检查 GitHub App 权限，以及 installation 是否重新批准过新权限。
- Runner service 返回 unauthorized：确认 `AGENT_RUNNER_SERVICE_TOKEN` 和 `RUNNER_SERVICE_TOKEN` 一致。
- Repository dispatch 鉴权失败：确认 workflow 配置了 `id-token: write`，请求了 `sec-review-bot` OIDC audience，并且 workflow 路径是 `.github/workflows/sec-review-bot.yml`。
- Worker 读不到 input bundle：从仓库根目录启动 Compose，并保持 input bundle 路径在 GitHub integration 容器、worker 和宿主 Docker daemon 眼里是同一个宿主机绝对路径。
- Worker 执行时 sandbox artifact 路径失败：保持 runner artifact 路径按 Docker sandbox 执行使用的同一个宿主机路径挂进 worker。
- LLM 调用在 workflow 推进前失败：运行 `sec-review-agents-check-llm-deployments --fail-fast`。
