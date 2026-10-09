# Control Plane UI

这是用于查看 Review Control Plane run 的内部只读控制台。浏览器只访问该应用的同源服务端；服务端持有 Control Plane 只读凭据，并仅代理明确白名单内的 GET 查询。

## 本地运行

在 `apps/control-plane-ui` 中安装依赖，并启动使用 fixture 的预览：

```bash
pnpm install
pnpm run dev:fixtures
```

打开 Vite 输出的地址，通常是 `http://localhost:5173`。这种模式提供有代表性的成功、运行中、等待重试和失败 run，不需要启动 Control Plane、PostgreSQL 或 RustFS；界面会显示 artifact 元数据，但没有可供下载的真实存储对象。

如需连接正在运行的 Control Plane，先在一个终端中构建并启动 BFF：

```bash
pnpm run build
CONTROL_PLANE_READ_TOKEN=local-read-token \
CONTROL_PLANE_UI_ACCESS_TOKEN=local-ui-token \
pnpm run server
```

再在另一个终端中启动 Vite：

```bash
pnpm run dev
```

Vite 会将 `/api` 请求代理到 `http://127.0.0.1:8091` 上的 BFF。BFF 默认连接 `http://127.0.0.1:8090` 上的 Control Plane；若 Control Plane 位于其他地址，请设置 `CONTROL_PLANE_URL`。下载 artifact 还需要配置[本地集成部署](../../docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)中列出的 RustFS 参数。

使用完整 Compose 部署时，默认访问地址为 `http://127.0.0.1:8091`。

## 本地检查

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

生产服务需要 `CONTROL_PLANE_READ_TOKEN` 和 `CONTROL_PLANE_UI_ACCESS_TOKEN`。只读 token 只能调用 Control Plane 查询路由；访问 token 用于建立 HTTP-only 浏览器会话，不能放入 Vite 变量或浏览器代码。

BFF 还负责代理下载私有 RustFS 中的终态 artifact。它使用单独的 `s3:GetObject` 凭据，该凭据仅可读取 `sec-review/runs/*/artifacts/*`；浏览器只提交 run ID，不会收到存储凭据或对象 URI。BFF 会先将对象写入临时文件，并根据 Control Plane 元数据校验大小和 SHA-256 摘要，再向浏览器返回下载。下载使用同一个 HTTP-only session 鉴权，固定作为附件返回，并受存储空闲超时限制。
