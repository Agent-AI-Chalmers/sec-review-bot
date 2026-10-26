# Execution Gateway

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`execution-gateway/` 是 Review Runs 与 Temporal 之间可独立部署的 TypeScript HTTP 边界。它校验 execution request、启动稳定的 Temporal execution workflow，并向调用方投影 workflow 状态。

Execution API v1 由 [`contracts/execution-api/v1`](../contracts/execution-api/v1/CONTRACT.zh.md) 定义。Temporal Execution Workflow 输入由 [`contracts/execution-workflow/v1`](../contracts/execution-workflow/v1/CONTRACT.md) 定义。

Gateway 不加载 agent 实现，也不运行 Temporal worker。这些职责属于 `agents/`。

## 本地运行

```bash
EXECUTION_GATEWAY_TOKEN=... \
TEMPORAL_ADDRESS=127.0.0.1:7233 \
pnpm run server
```

## 检查

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```
