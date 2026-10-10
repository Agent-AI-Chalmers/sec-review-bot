# Agent Runner HTTP API

语言：[English](RUNNER_HTTP_API.md) | 中文

本文是 [RUNNER_HTTP_API.md](RUNNER_HTTP_API.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这是生产 runner service 的 HTTP API。workflow 的输入和结果字段见 [契约 v5](v5/CONTRACT.zh.md)。

## 认证

当设置了 `RUNNER_SERVICE_TOKEN` 时，所有端点都要求：

```http
Authorization: Bearer <token>
```

未设置 `RUNNER_SERVICE_TOKEN` 时，服务只有在 `RUNNER_SERVICE_HOST` 是 loopback（如 `127.0.0.1` 或 `localhost`）时才会启动。Compose 和任何非 loopback 绑定都要求显式设置 `RUNNER_SERVICE_TOKEN`。

## 支持的 workflow

- `issue-review`
- `pull-request-review`
- `repository-review`

`issue-review-two-stage` 和 `issue-review-single-agent` 是本地评测 / ablation 专用路径，可由 local CLI 启动为 local-only Temporal workflow；它们不被标准 HTTP API 接受，外部调用方不应依赖。

## 创建运行

```http
POST /v1/workflows/{workflow}/runs
```

### 请求体

```json
{
  "run_id": "run-001",
  "input": {},
  "runtime": {}
}
```

字段要求：

- `workflow`：路径参数，必须是公开 workflow 名称。
- `run_id`：调用方选择的 run 标识；必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`。runner 用它标识这次运行，并决定产物目录。非法值会同步返回 `RUNNER_REQUEST_INVALID`；runner 不会自动修正或裁剪 `run_id`。
- `input`：workflow 输入对象。
- `runtime`：可选的 runner 运行时配置。

允许的 `runtime` key 是 `workspace_image?: string`。未知 runtime key 会让 runner preparation 以 `RUNNER_REQUEST_INVALID` 失败；创建运行接口只做轻量同步校验，仍可能先返回 accepted/running。

`runtime.workspace_image` 目前是内部 / evaluation runner option。GitHub App 不通过仓库配置暴露这个字段。产品侧集成不得从仓库配置、评论、issue / PR 内容或其他不可信用户输入中派生或透传该值。

`run_id` 同时也是创建运行的幂等键。在对应 workflow 仍处于 Temporal 历史保留期（retention）内时，第一个被接纳的请求会把该 ID 绑定到 `workflow`、`input` 和 `runtime` 的规范化 JSON 值：

- 使用相同 `run_id` 重放相同请求时，返回已有运行；运行已经完成时也一样。
- 使用相同 `run_id` 提交不同请求内容时，返回 HTTP `409` 和 `RUNNER_RUN_CONFLICT`。
- 已完成、失败、取消或超时的 run ID 不会被用于启动新的 Temporal execution。

> Temporal 删除过期 workflow history 后，runner 将无法恢复该 ID 与原请求的绑定关系。调用方必须为每个新 run 生成全新且具备足够抗碰撞能力的 `run_id`，并且不得故意复用已经过期的 ID。此 API 契约不提供超出 Temporal 历史保留期的永久去重保证。

JSON object 的 key 顺序不影响请求身份；array 顺序或字段值变化会影响请求身份。

### 接受响应

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "running"
}
```

## 查询运行

```http
GET /v1/runs/{run_id}
```

### 运行中响应

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "running"
}
```

### 成功响应

只有当 workflow 完成，且其 result 符合该 workflow 的公开 v5 schema 时，Runner 才会报告 `succeeded`。如果 workflow 已完成但返回了非法的公开 result，Runner 会以 `RUNNER_RESPONSE_INVALID` 报告失败；Runner 不会在这个边界猜测如何修复契约字段。

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "succeeded",
  "result": {},
  "artifact_storage": {
    "status": "available",
    "artifact": {
      "kind": "diagnostic_bundle",
      "uri": "s3://sec-review/runs/run-001/artifacts/diagnostic-tree.v1.tar.zst",
      "media_type": "application/zstd",
      "digest": "sha256:0123456789abcdef...",
      "size_bytes": 12345
    }
  }
}
```

`artifact_storage` 与 workflow 业务结果相互独立。其状态为 `available`、`unavailable` 或 `failed`；诊断材料存储失败不会改变 workflow 的业务结果。

### 失败响应

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "failed",
  "error": {
    "category": "runtime",
    "code": "RUNNER_EXECUTION_FAILED",
    "message": "RuntimeError: boom from issue analyzer",
    "retryable": false,
    "details": {
      "temporal_status": "FAILED",
      "name": "RuntimeError",
      "failure_chain": [
        {
          "name": "WorkflowFailureError",
          "message": "Workflow execution failed"
        },
        {
          "name": "RuntimeError",
          "message": "RuntimeError: boom from issue analyzer"
        }
      ]
    }
  }
}
```

## 查询运行状态

`POST /v1/runs/status` 用一次请求读取多个运行的状态。它服务于同时跟踪多个运行的调用方：如果对每个运行各调用一次[查询运行](#查询运行)，请求数就会随在飞的运行数增长，于是最忙的时刻发出的请求最多。

响应只携带状态令牌。需要某个运行产出了什么的调用方，在该运行到达终态时通过一次[查询运行](#查询运行)取回它，而不是在每个间隔里接收所有结果。

### 请求体

```json
{
  "run_ids": ["6f1c8f2a-2d3e-4a5b-8c7d-9e0f1a2b3c4d"]
}
```

- `run_ids`：必填。至少一个、至多 200 个，每个都需符合 run ID 规则。重复的 ID 只读取一次。

### 状态响应

```json
{
  "runs": [
    { "run_id": "6f1c8f2a-2d3e-4a5b-8c7d-9e0f1a2b3c4d", "status": "running" },
    { "run_id": "0a94c1de-3f4a-4b6c-9d8e-1f2a3b4c5d6e", "status": "succeeded" }
  ],
  "missing": ["3b77aa10-5c6d-4e7f-8a9b-0c1d2e3f4a5b"]
}
```

- `runs`：每个已知运行一条，顺序与请求一致，各带该运行的 `run_id` 与 `status`。
- `missing`：Runner 没有记录的请求 run ID。它们被报告出来而不是被丢弃，这样调用方无需把响应与自己的请求做比对，就能区分"从未被接受"和"被 Runner 跳过了"。

## 错误响应

### 错误体

同步请求校验错误返回 HTTP `400`，响应体为：

```json
{
  "error": {
    "category": "input",
    "code": "RUNNER_REQUEST_INVALID",
    "message": "...",
    "retryable": false,
    "details": {}
  }
}
```

对于仍处于 Temporal 历史保留期内的 `run_id`，复用该 ID 但改变请求内容时会返回 HTTP `409`，并使用相同错误 envelope 和错误码 `RUNNER_RUN_CONFLICT`。该错误不可重试；调用方必须重放原请求，或为新请求选择新的 `run_id`。

错误字段：

- `category`：input | workflow | llm | runtime | internal
- `code`：稳定的机器可读错误码
- `message`：简短可读的错误信息
- `retryable`：boolean
- `details`：诊断信息对象

运行时失败不会伪造成 workflow `result`，也不会作为 stage-level `status="error"` 混进结果里。Activity / child workflow 异常由 Temporal retry 和 workflow failure 处理；`GET /v1/runs/{run_id}` 在最终失败时返回 `RUNNER_EXECUTION_FAILED`，`message` 应包含 Temporal failure root cause，`details.failure_chain` 可包含从 Temporal wrapper error 到 root cause 的诊断链。

对于合法的 run ID，如果 Runner 没有保存对应的执行记录，`GET /v1/runs/{run_id}` 会返回 HTTP `404` 和 `RUNNER_RUN_NOT_FOUND`。普通路由 `404` 不属于这个错误，不能据此判断 run 已经消失。

### Runner 错误码

- `RUNNER_REQUEST_INVALID`
- `RUNNER_WORKFLOW_UNSUPPORTED`
- `RUNNER_RUN_CONFLICT`
- `RUNNER_RUN_NOT_FOUND`
- `RUNNER_RESPONSE_INVALID`
- `RUNNER_EXECUTION_FAILED`

## 兼容性规则

以下变化属于破坏性变更：

- HTTP path / method 变化
- request / response 必需字段变化
- error body 必需字段变化
- workflow 名称与 input 必需字段变化

新增端点、端点选项或可选请求/响应字段属于非破坏性扩展。
