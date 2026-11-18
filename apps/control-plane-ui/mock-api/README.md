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

The data generator and validator are imported directly by browser component tests as well as the mock server. Keep their runtime dependencies browser-compatible: they must not import Node APIs, Vite, the router, or HTTP handlers. Server integration belongs in the plugin and route modules.

The mock API is validated by `test/checks/mock-api.test.ts`. Application E2E covers the assembled UI against its HTTP behavior. Package `scripts/` owns command-line checks and reports.

## State lifetime

<!-- doc-default: control-plane-ui.mock-api-state; source=apps/control-plane-ui/mock-api/router.ts -->

Each router instance creates its own session and resource handlers. Run handlers clone the initial run records; memory handlers initialize their own mutable state. Starting a local E2E fixture server creates a new router, while interactions in one development-server session share that router's state.

<!-- doc-default: control-plane-ui.mock-api-time; source=apps/control-plane-ui/mock-api/runs/generate.ts -->

The generator evaluates `BASE_TIME` and initial records at module load, using the current clock for some fields. Router recreation does not by itself regenerate cached module exports. Preserve that distinction when writing time-sensitive tests.

The environment switch controls development middleware registration. Configuration dependencies can still evaluate when Vite loads its configuration, including during builds. Browser bundle inclusion depends on the application imports and build graph.
