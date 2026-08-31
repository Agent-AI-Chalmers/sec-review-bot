# Docker Compose Deployment

Language: English | [中文](DOCKER_COMPOSE_DEPLOYMENT.zh.md)

This is the local deployment guide for the full GitHub integration / runner service / runner worker / Temporal path.

Use it when you want to run the integrated system locally. For direct local runs and local `run-local-* --temporal` debugging without the HTTP runner service, see [agents/README.md](../../agents/README.md).

## Local Path

This Compose setup runs the production-shaped path on one development machine: GitHub integration receives GitHub webhooks or GitHub Actions-authenticated HTTP dispatches, prepares runner input bundles, and submits runs to Runner Service. Runner Service starts workflows through Temporal. Runner Worker executes activities and uses the Docker sandbox when agents need file or command tools.

Compose services map to that path like this:

- `github-integration`: GitHub platform entrypoint, input bundle preparation, and GitHub publishing
- `runner-service`: HTTP runner API for run submission and Temporal workflow start
- `runner-worker`: Temporal worker that executes workflow activities
- `temporal`: local Temporal server and task queue

Default local endpoints:

| Service | URL |
| --- | --- |
| GitHub integration | `http://127.0.0.1:30000` |
| Runner Service | `http://127.0.0.1:8000` |
| Temporal Web UI | `http://127.0.0.1:8233` |

## Required Files

From the repository root:

```bash
cp compose.env.sample .env
cp agents/.env.sample agents/.env
cp agents/config/model-providers.sample.toml agents/config/model-providers.toml
cp apps/github-integration/.env.sample apps/github-integration/.env
```

Then fill:

- `agents/.env`
- `agents/config/model-providers.toml`
- `apps/github-integration/.env`

Place the GitHub App private key at:

```text
apps/github-integration/private-key.pem
```

Compose mounts `agents/config/model-providers.toml` into the runner service and worker as a secret. Do not skip it.

## Local Paths

Compose uses three local state roots:

| Path | Owner | Purpose |
| --- | --- | --- |
| `.agent-input-bundles` | GitHub integration writes, runner reads | Prepared runner input materials |
| `.agent-artifacts` | Runner service / worker | Agent artifacts and workflow outputs for each run |
| `.agent-app-state` | GitHub integration | Submitted-run state for background publishing |

Start Docker Compose from the repository root. The app, worker, and Docker sandbox pass around absolute host paths for input bundles and artifacts. If Compose is started from another directory, those paths may no longer match what the host Docker daemon can mount.

## Environment Variables

There are three configuration layers, each with its own file.

### 1. Compose `.env`

Compose-level defaults live in [compose.env.sample](../../compose.env.sample). This file controls how Compose starts containers, mounts local directories, and exposes ports. Copy it to `.env` in the repository root before starting Compose if you want to override defaults.

Common path settings:

```bash
RUNNER_SERVICE_TOKEN=<generate with: openssl rand -hex 32>
SEC_REVIEW_INPUT_BUNDLE_ROOT=${PWD}/.agent-input-bundles
SEC_REVIEW_AGENT_ARTIFACT_ROOT=${PWD}/.agent-artifacts
SEC_REVIEW_APP_STATE_ROOT=${PWD}/.agent-app-state
```

### 2. GitHub integration `.env`

GitHub integration runtime settings live in [apps/github-integration/.env.sample](../../apps/github-integration/.env.sample). Minimum local values:

```bash
APP_ID=123456
PRIVATE_KEY_PATH=/absolute/path/to/private-key.pem
WEBHOOK_SECRET=your_webhook_secret
PORT=30000
AGENT_RUNNER_SERVICE_URL=http://127.0.0.1:8000
AGENT_RUNNER_SERVICE_TOKEN=<same value as RUNNER_SERVICE_TOKEN>
```

Compose overrides the private key path and runner service address for the containerized app.

### 3. Agents config

Agents-side settings live in [agents/.env.sample](../../agents/.env.sample). The model deployment config lives in [agents/config/model-providers.sample.toml](../../agents/config/model-providers.sample.toml).

Every agent that can run must be explicitly bound to a model deployment:

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

After changing model config or credentials, you can probe deployment availability:

```bash
cd agents
sec-review-agents-check-llm-deployments
sec-review-agents-check-llm-deployments --fail-fast
```

## GitHub App Setup

Required repository permissions:

- `Pull requests: Read and write`
- `Contents: Read and write`
- `Issues: Read and write`

Required webhook subscriptions:

- `Pull request`
- `Issues`
- `Issue comment`

Notes:

- `Metadata: Read-only` is the default GitHub App permission and does not need to be enabled manually.
- If you change App permissions, existing installations often need to re-approve the new permissions.
- When permissions are insufficient, a common error is `403 Resource not accessible by integration`.

For webhook routing from a public URL into your local GitHub integration service, see [LOCAL_WEBHOOK_SETUP.md](LOCAL_WEBHOOK_SETUP.md).

## Repository Review Dispatch

Repository review is triggered through [`.github/workflows/sec-review-bot.yml`](../../.github/workflows/sec-review-bot.yml) with `workflow_dispatch` or `schedule`.

Configure these repository Actions secrets in the target repository:

```bash
SEC_BOT_DISPATCH_URL=https://your-bot-dev.example.com/api/repository-review/dispatch
```

The repository review workflow authenticates to the App with GitHub Actions OIDC. The workflow must have `id-token: write`, and the OIDC audience is fixed to `sec-review-bot`.

## Start

Start the full stack:

```bash
docker compose --profile app up --build
```

This starts the GitHub integration service, runner service, runner worker, and Temporal.

This Compose setup is image-based. After changing GitHub integration or agents code, rebuild and recreate the affected containers:

```bash
docker compose --profile app up --build --force-recreate
```

It is not a hot-reload development loop.

Runner backend only:

```bash
docker compose up --build temporal runner-service runner-worker
```

Check the runner service:

```bash
RUNNER_SERVICE_TOKEN=<paste-your-token>
curl -sS http://127.0.0.1:8000/healthz \
  -H "Authorization: Bearer ${RUNNER_SERVICE_TOKEN}"
```

## Optional Runtime Controls

Langfuse tracing:

```bash
LANGFUSE_PUBLIC_KEY=your_public_key
LANGFUSE_SECRET_KEY=your_secret_key
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Runtime diagnostics:

```bash
AGENT_LOG_LEVEL=INFO
AGENT_MODEL_TURN_DIAGNOSTICS=1
AGENT_GRAPH_MAX_STEPS=24
AGENT_GRAPH_RECURSION_BUFFER=8
```

Repository workflow concurrency:

```bash
AGENT_DISCOVERY_MAX_CONCURRENCY=1
AGENT_CASE_PROCESSING_MAX_CONCURRENCY=1
```

Concurrency only limits in-flight requests. It is not the same as TPM/RPM rate limiting; quota pressure depends more on token volume, request rate, and retry behavior.

Docker sandbox:

```bash
AGENT_SANDBOX_BACKEND=docker
AGENT_DOCKER_IMAGE=mcr.microsoft.com/devcontainers/universal:6-noble
AGENT_DOCKER_NETWORK_MODE=none
```

The default Compose strategy is `auto`: use Docker sandbox when Docker is available, otherwise fall back to the local filesystem backend.

Optional CodeGraph MCP for Docker sandbox:

```bash
docker build -f agents/docker/workspace-codegraph.Dockerfile -t sec-review-bot-workspace:codegraph agents
AGENT_DOCKER_IMAGE=sec-review-bot-workspace:codegraph
AGENT_MCP_ENABLED=true
```

For local fallback, install `codegraph` on the host `PATH` and set `AGENT_MCP_ENABLED=true`. CodeGraph tools are only attached for stages that opt in and expose a writable `/workspace`.

## Cleanup

Compose uses the simplest permission model: App, worker, and sandbox all run as the container default root user. The tradeoff is that local bundle / artifact directories may contain root-owned files.

Clean them up with:

```bash
sudo chown -R "$USER:$USER" .agent-input-bundles .agent-artifacts .agent-app-state
```

Or remove them after confirming the runs are no longer needed:

```bash
sudo rm -rf .agent-input-bundles .agent-artifacts .agent-app-state
```

## Troubleshooting

- `403 Resource not accessible by integration`: check GitHub App permissions and whether the installation re-approved changed permissions.
- Runner service returns unauthorized: make sure `AGENT_RUNNER_SERVICE_TOKEN` matches `RUNNER_SERVICE_TOKEN`.
- Repository dispatch fails authentication: make sure the workflow has `id-token: write`, requests the `sec-review-bot` OIDC audience, and uses the `.github/workflows/sec-review-bot.yml` workflow path.
- Worker cannot read input bundles: start Compose from the repository root and keep the input bundle path under the same absolute host path for the GitHub integration container, worker, and host Docker daemon.
- Sandbox artifact paths fail during worker execution: keep the runner artifact path mounted into the worker at the same host path used by Docker sandbox execution.
- LLM calls fail before workflow progress: run `sec-review-agents-check-llm-deployments --fail-fast`.
