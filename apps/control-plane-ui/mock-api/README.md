# Development mock API

This directory owns the stateful API used to preview the UI without its backend services. Start the application with `pnpm dev:mock` from the UI package. Local Playwright tests use the same implementation with a fresh Vite server for each test.

<!-- doc-default: control-plane-ui.mock-api-entry; source=apps/control-plane-ui/vite.config.ts -->

`vite.config.ts` imports `index.ts` and registers its Vite plugin when `CONTROL_PLANE_UI_MOCK_API=1`. `configureServer` installs the router as development middleware.

## Ownership

| Module                                    | Responsibility                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `index.ts`                                | Vite development-server integration                                                 |
| `router.ts`                               | Request dispatch, session state, and creation of resource handlers                  |
| `runs/routes.ts` and `memory/routes.ts`   | Stateful HTTP responses and mutations                                               |
| `runs/generate.ts` and `runs/validate.ts` | Shared scenario projections and reachable-state validation                          |
| `data/`                                   | Sanitized example payloads and scenario inputs; see [data guidance](data/README.md) |

Browser component tests and the mock server both use the data generator, which imports the validator. Keep their runtime dependencies browser-compatible: they must not import Node APIs, Vite, the router, or HTTP handlers. Server integration belongs in the plugin and route modules.

The mock API is validated by `test/checks/mock-api.test.ts`. `test/checks/mock-api-boundaries.test.ts` builds the generator and validator as browser entries and rejects Node, Vite, and server-integration dependencies throughout their import graph. Application E2E covers the assembled UI against its HTTP behavior. Package `scripts/` owns command-line checks and reports.

## State lifetime

<!-- doc-default: control-plane-ui.mock-api-state; source=apps/control-plane-ui/mock-api/router.ts -->

Each router instance creates fresh run records, publication steps, session state, and memory state. The generator takes a clock snapshot explicitly; importing it does not create or cache records. Starting a local E2E fixture server creates a new router, while interactions in one development-server session share that router's state.

<!-- doc-default: CONTROL_PLANE_UI_MOCK_API_NOW; source=apps/control-plane-ui/mock-api/index.ts -->

Set `CONTROL_PLANE_UI_MOCK_API_NOW` to a parseable date/time, preferably an ISO 8601 timestamp with a timezone, to fix the clock for initial records and subsequent mutations across both runs and memory. For example, `CONTROL_PLANE_UI_MOCK_API_NOW=2026-11-12T12:00:00Z pnpm dev:mock`. Invalid values fail server initialization. Without the variable, initial records use the server's current time and mutations use the live clock. The plugin reads the setting when installing each server's router, so configuration import order does not freeze the time.

<!-- doc-default: control-plane-ui.mock-api-time; source=apps/control-plane-ui/mock-api/runs/generate.ts -->

Historical runs are spaced relative to a baseline before the snapshot, while active runs are anchored near the snapshot. Memory records use the same clock with their scenario-specific offsets. Regenerating a router regenerates its data; timestamp equality between different domains is not implied.

<!-- doc-default: control-plane-ui.mock-api-browser-clock; source=apps/control-plane-ui/test/e2e/fixtures.ts -->

Local E2E fixes this server clock and the browser's Date to the same reference time. Browser timers continue normally. Tests against an external deployment leave its clock and browser Date unchanged. The local fixture restores the previous mock API environment settings after closing its server, including on failure.

The environment switch controls development middleware registration. Configuration dependencies can still evaluate when Vite loads its configuration, including during builds. Browser bundle inclusion depends on the application imports and build graph.
