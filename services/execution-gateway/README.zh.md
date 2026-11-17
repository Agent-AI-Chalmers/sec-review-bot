# Execution Gateway

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

`services/execution-gateway/` 是 Review Runs 与 Temporal 之间的可独立部署的 TypeScript HTTP 服务。它校验执行请求、按约定的身份启动 Temporal execution workflow，并向调用方返回执行状态。

Execution API v1 由 [`contracts/execution-api/v1`](../../contracts/execution-api/v1/CONTRACT.zh.md) 定义。Temporal Execution Workflow 输入由 [`contracts/execution-workflow/v1`](../../contracts/execution-workflow/v1/CONTRACT.md) 定义。

Execution Gateway 不加载 Agent 实现，也不运行 Temporal Worker；审查执行由 `agents/` 提供。

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
pnpm run test:integration
```

<!-- doc-default: execution-gateway.test-projects; source=services/execution-gateway/vitest.config.ts -->

`pnpm test` 构建服务并运行隔离测试。开发时可用 `pnpm run test:dev test/env.test.ts` 直接从源码运行指定测试，无需构建；省略路径会运行全部隔离测试。完成前仍需运行 `pnpm test`，保留构建验证。集成测试通过 `pnpm run test:integration` 单独运行，也可以追加测试路径或测试运行选项。

`pnpm run test:integration` 使用显式提供的 `TEST_TEMPORAL_ADDRESS` 测试 workflow 提交和请求身份；未设置时，launcher 会使用仓库 `compose.yaml` 中配置的镜像创建并清理一个临时本地 Docker Temporal 服务。Launcher 会有意忽略服务常规使用的 `TEMPORAL_ADDRESS`，避免测试意外在共享部署中创建 workflow。
