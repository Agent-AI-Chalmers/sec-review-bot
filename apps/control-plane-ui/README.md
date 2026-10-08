# Control Plane UI

Internal, read-only web console for Review Control Plane runs. The browser talks only to this application's same-origin server; the server holds the Control Plane read credential and proxies an explicit GET-only query allowlist.

## Local checks

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

Run `pnpm run dev` against the local UI server on port 8091, or use `pnpm run dev:fixtures` to preview the complete interface with fixed development data and no backend services.

The production server requires `CONTROL_PLANE_READ_TOKEN` and `CONTROL_PLANE_UI_ACCESS_TOKEN`. The read token calls Control Plane query routes only. The access token creates an HTTP-only browser session and must not be placed in Vite variables or browser code.

The default local URL is `http://127.0.0.1:8091` when started through Compose.
