# Control Plane UI

这是用于查看 Review Control Plane run 的内部只读控制台。浏览器只访问该应用的同源服务端；服务端持有 Control Plane 只读凭据，并仅代理明确白名单内的 GET 查询。

## 本地检查

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

生产服务需要 `CONTROL_PLANE_READ_TOKEN` 和 `CONTROL_PLANE_UI_ACCESS_TOKEN`。只读 token 只能调用 Control Plane 查询路由；访问 token 用于建立 HTTP-only 浏览器会话，不能放入 Vite 变量或浏览器代码。

通过 Compose 启动时，默认本地地址为 `http://127.0.0.1:8091`。
