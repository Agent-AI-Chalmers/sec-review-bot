# Agent Runner HTTP API

语言：[English](RUNNER_HTTP_API.md) | 中文

本文是 [RUNNER_HTTP_API.md](RUNNER_HTTP_API.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这是生产 runner service 的 HTTP API。workflow 的输入和结果字段见 [契约 v4](CONTRACT_V4.zh.md)。

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

```json
{
  "run_id": "run-001",
  "workflow": "issue-review",
  "status": "succeeded",
  "result": {}
}
```

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

错误字段：

- `category`：input | workflow | llm | runtime | internal
- `code`：稳定的机器可读错误码
- `message`：简短可读的错误信息
- `retryable`：boolean
- `details`：诊断信息对象

运行时失败不会伪造成 workflow `result`，也不会作为 stage-level `status="error"` 混进结果里。Activity / child workflow 异常由 Temporal retry 和 workflow failure 处理；`GET /v1/runs/{run_id}` 在最终失败时返回 `RUNNER_EXECUTION_FAILED`，`message` 应包含 Temporal failure root cause，`details.failure_chain` 可包含从 Temporal wrapper error 到 root cause 的诊断链。

### Runner 错误码

- `RUNNER_REQUEST_INVALID`
- `RUNNER_WORKFLOW_UNSUPPORTED`
- `RUNNER_RESPONSE_INVALID`
- `RUNNER_EXECUTION_FAILED`

## 兼容性规则

以下变化属于破坏性变更：

- HTTP path / method 变化
- request / response 必需字段变化
- error body 必需字段变化
- workflow 名称与 input 必需字段变化

新增可选字段属于非破坏性扩展。
