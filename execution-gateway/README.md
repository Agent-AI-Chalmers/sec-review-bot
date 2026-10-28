# Execution Gateway

Language: English | [中文](README.zh.md)

`execution-gateway/` is the independently deployable TypeScript HTTP boundary between Review Runs and Temporal. It validates execution requests, starts the stable Temporal execution workflow, and projects workflow state for callers.

Execution API v1 is defined by [`contracts/execution-api/v1`](../contracts/execution-api/v1/CONTRACT.md). The Temporal Execution Workflow input is defined by [`contracts/execution-workflow/v1`](../contracts/execution-workflow/v1/CONTRACT.md).

The Gateway does not load agent implementations or run Temporal workers. Those responsibilities belong to `agents/`.

## Run Locally

```bash
EXECUTION_GATEWAY_TOKEN=... \
TEMPORAL_ADDRESS=127.0.0.1:7233 \
pnpm run server
```

## Checks

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

`pnpm test` runs the isolated validation and HTTP tests. `pnpm run test:integration` exercises workflow submission and request identity against an explicitly supplied `TEST_TEMPORAL_ADDRESS`; when it is unset, the launcher creates and removes a temporary local Docker Temporal service using the image configured in the repository `compose.yaml`. The launcher deliberately ignores the service's ordinary `TEMPORAL_ADDRESS` so a test cannot create workflows in a shared deployment by accident.
