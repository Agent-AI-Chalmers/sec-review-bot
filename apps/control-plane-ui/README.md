# Control Plane UI

Internal web console for review runs and memory operations. The browser talks only to this application's same-origin server; the server holds upstream credentials and proxies explicit route allowlists.

## Local development

From `apps/control-plane-ui`, install dependencies and start the fixture-backed preview:

```bash
pnpm install
pnpm run dev:fixtures
```

Open the URL printed by Vite, normally `http://localhost:5173`. This mode supplies representative run and memory states without requiring Review Runs, Memory Catalog, PostgreSQL, or RustFS. Memory pause, resume, edit, and restore controls are stateful fixtures. Memory tree and transcript actions return small fixture attachments so their browser download behavior can be exercised without stored objects.

The Viewer page is entirely local to the browser. It accepts one JSON or JSONL transcript file, or pasted transcript content, and renders the messages without uploading the input to the BFF.

## Source layout

The package is organized by runtime first, then by browser feature ownership:

```text
browser/
  app/                application shell, session UI, preferences, and theme
  features/
    runs/             run list, detail, status, and Review Runs projections
    memory/           memory inspection and Memory Catalog projections
    workspace/        file browsing and editing used by runs and memory
    transcript/       transcript model and renderer
    viewer/           local transcript viewer page
  shared/             browser-only infrastructure and small utilities
  styles/             ordered stylesheet sections
  main.tsx            browser entry point
server/               Node BFF
shared/               values imported by both browser and server
scripts/              development-time package tooling
test/                 browser and server tests
```

Feature domains must not import one another. Reusable browser capabilities live under `browser/features/` or `browser/shared/`, while package-level `shared/` is reserved for code that genuinely crosses the browser/server runtime boundary.

The fixtures serve a few dozen runs at Review Runs' default page size and implement its cursor contract, so paging, the status filters, the detail timeline, and settled model-usage snapshots are all exercised without a backend. Every generated run is checked against the states the store can actually produce, so an unreachable combination fails the module import instead of appearing as plausible-looking demo data.

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

Vite proxies `/api` requests to the BFF at `http://127.0.0.1:8091`. The BFF connects to Review Runs at `http://127.0.0.1:8090` by default; set `REVIEW_RUNS_URL` when it runs elsewhere. Artifact downloads additionally require the S3 settings documented in [Local Integrated Deployment](../../docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.md). AWS can use its default endpoint with `SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE=auto`; the local RustFS deployment supplies its endpoint and uses `path`.

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

The server-side memory tree reader and builder implement the versioned [memory-tree profile](../../contracts/tar-zstd-artifact/profiles/memory-tree/README.md). They remain outside the browser bundle; the BFF is responsible for validation, digest calculation, and canonical object keys.

Set `MEMORY_CATALOG_URL` and `MEMORY_CATALOG_TOKEN` to enable memory management. The BFF strips storage URIs from Catalog JSON, fetches artifacts itself, and verifies their size and SHA-256 digest before returning content or downloads.

The authenticated control plane can pause or resume maintenance, edit the active memory tree, and restore an existing revision. The BFF derives actor identity server-side and uses expected-active-revision and control-generation compare-and-swap. Its S3 identity can create immutable objects only under `memory/trees/*`; run artifacts and memory transcripts remain read-only. A failed edit or restore does not resume maintenance automatically.
