# Control Plane UI

Internal web console for review runs. The browser talks only to this application's same-origin server; the server holds Review Runs read credential and proxies an explicit allowlist of GET paths, forwarding the query string unchanged.

## Local development

From `apps/control-plane-ui`, install dependencies and start the fixture-backed preview:

```bash
pnpm install
pnpm run dev:fixtures
```

Open the URL printed by Vite, normally `http://localhost:5173`. This mode supplies representative successful, active, recovering, publishing, and failed runs without requiring Review Runs, PostgreSQL, or RustFS. Artifact metadata is visible, but there are no stored objects to download.

The fixtures serve a few dozen runs at Review Runs' default page size and implement its cursor contract, so paging, the status filters, and the detail timeline are all exercised without a backend. Every generated run is checked against the states the store can actually produce, so an unreachable combination fails the module import instead of appearing as plausible-looking demo data.

To develop against a running Review Runs, build and start the BFF in one terminal:

```bash
pnpm run build
REVIEW_RUNS_READ_TOKEN=local-read-token \
CONTROL_PLANE_UI_ACCESS_TOKEN=local-ui-token \
pnpm run server
```

Then start Vite in another terminal:

```bash
pnpm run dev
```

Vite proxies `/api` requests to the BFF at `http://127.0.0.1:8091`. The BFF connects to Review Runs at `http://127.0.0.1:8090` by default; set `REVIEW_RUNS_URL` when it runs elsewhere. Artifact downloads additionally require the RustFS settings documented in [Local Integrated Deployment](../../docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.md).

The complete Compose deployment is available at `http://127.0.0.1:8091` by default.

## Local checks

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

The production server requires `REVIEW_RUNS_READ_TOKEN` and `CONTROL_PLANE_UI_ACCESS_TOKEN`, and they answer different questions. The access token decides who may open the console: the browser exchanges it for an HTTP-only session cookie, and the token itself never reaches browser code or Vite variables. The read token is what the backend then uses to call Review Runs query routes on the signed-in user's behalf; it never leaves the server either. Keeping them separate means a console account and a read key can be issued, rotated, and revoked independently — a read-only consumer such as a dashboard holds only the read token and has no console access.

The BFF also proxies terminal artifact downloads from private RustFS storage. It receives a dedicated `s3:GetObject` credential restricted to `sec-review/runs/*/artifacts/*`; the browser supplies only a run ID and never receives storage credentials or an object URI. Before responding to the browser, the BFF writes the object to a temporary file and verifies its size and SHA-256 digest against Review Runs metadata. Downloads are attachment-only, bounded by a storage idle timeout, and protected by the same HTTP-only session.
