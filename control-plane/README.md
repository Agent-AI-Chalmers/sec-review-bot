# Control Plane

[中文版](README.zh.md)

This service is the repository's third top-level module, alongside `apps/` and `agents/`. It owns review-run admission, durable coordination state, and state transitions.

It runs as an independently deployed Node.js service on port `8090` by default. The GitHub integration reaches its authenticated internal HTTP API and does not receive PostgreSQL credentials.

Platform parsing, Runner polling, and GitHub publication orchestration remain in `apps/`. Temporal and agent execution remain in `agents/`. Input and terminal artifacts cross the boundary through `ArtifactRef`, not copied archive bytes.
