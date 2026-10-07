# Control Plane

[中文版](README.zh.md)

This service is the repository's third top-level module, alongside `apps/` and `agents/`. It owns review-run admission, durable coordination state, and state transitions.

It runs as an independently deployed Node.js service on port `8090` by default. The GitHub integration reaches its authenticated internal HTTP API and does not receive PostgreSQL credentials.

Platform parsing and GitHub publication orchestration remain in `apps/`. Control Plane observes Runner and persists its terminal result before exposing publication work for the integration to claim. Temporal and agent execution remain in `agents/`. Input and terminal artifacts cross the boundary through `ArtifactRef`, not copied archive bytes.

## Commands

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```
