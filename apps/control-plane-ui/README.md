# Control Plane UI

Internal, read-only web console for Review Control Plane runs. The browser talks only to this application's same-origin server; the server holds the Control Plane read credential and proxies an explicit GET-only query allowlist.

## Local development

From `apps/control-plane-ui`, install dependencies and start the fixture-backed preview:

```bash
pnpm install
pnpm run dev:fixtures
```

Open the URL printed by Vite, normally `http://localhost:5173`. This mode supplies representative successful, active, retrying, and failed runs without requiring Control Plane, PostgreSQL, or RustFS. Artifact metadata is visible, but there are no stored objects to download.

To develop against a running Control Plane, build and start the BFF in one terminal:

```bash
pnpm run build
CONTROL_PLANE_READ_TOKEN=local-read-token \
CONTROL_PLANE_UI_ACCESS_TOKEN=local-ui-token \
pnpm run server
```

Then start Vite in another terminal:

```bash
pnpm run dev
```

Vite proxies `/api` requests to the BFF at `http://127.0.0.1:8091`. The BFF connects to Control Plane at `http://127.0.0.1:8090` by default; set `CONTROL_PLANE_URL` when it runs elsewhere. Artifact downloads additionally require the RustFS settings documented in [Local Integrated Deployment](../../docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.md).

The complete Compose deployment is available at `http://127.0.0.1:8091` by default.

## Local checks

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

The production server requires `CONTROL_PLANE_READ_TOKEN` and `CONTROL_PLANE_UI_ACCESS_TOKEN`. The read token calls Control Plane query routes only. The access token creates an HTTP-only browser session and must not be placed in Vite variables or browser code.

The BFF also proxies terminal artifact downloads from private RustFS storage. It receives a dedicated `s3:GetObject` credential restricted to `sec-review/runs/*/artifacts/*`; the browser supplies only a run ID and never receives storage credentials or an object URI. Before responding to the browser, the BFF writes the object to a temporary file and verifies its size and SHA-256 digest against Control Plane metadata. Downloads are attachment-only, bounded by a storage idle timeout, and protected by the same HTTP-only session.
