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

The production server requires `CONTROL_PLANE_READ_TOKEN` and `CONTROL_PLANE_UI_ACCESS_TOKEN`. The read token calls Control Plane query routes only. The access token creates an HTTP-only browser session and must not be placed in Vite variables or browser code.

The default local URL is `http://127.0.0.1:8091` when started through Compose.
