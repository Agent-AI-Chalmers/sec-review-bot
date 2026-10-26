# Execution Gateway

Language: English | [中文](README.zh.md)

`execution-gateway/` is the independently deployable TypeScript HTTP boundary between Review Control Plane and Temporal. It validates execution requests, starts the stable Temporal execution workflow, and projects workflow state for callers.

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
```
