# Control Plane

本服务是仓库中与 `apps/`、`agents/` 平级的第三个顶层模块，负责 review run 接纳、持久化协调状态和状态转换。

它是独立部署的 Node.js 服务，默认监听 `8090`。GitHub integration 通过受认证的内部 HTTP API 调用它，不再持有 PostgreSQL 凭据。

平台请求解析、Runner 轮询和 GitHub 发布编排留在 `apps/`，Temporal workflow 和 agent 执行留在 `agents/`。Input 和终态 artifact 通过 `ArtifactRef` 跨越边界，不复制 archive 内容。
