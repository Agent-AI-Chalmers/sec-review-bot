# Filesystem Backends

This package owns the agent-visible filesystem and command-execution backends. It is maintainer-facing; public project docs should keep describing the normal Docker-first policy unless an experimental backend becomes a supported default.

## Backend Shape

- `docker`: service-side and benchmark-oriented execution sandbox. Use this when running other people's code should not happen directly on the host, when a stage needs a pinned image, or when tooling must be reproducible across machines. This is the normal backend for execution-heavy analyzer / mitigation / verification paths.
- `bwrap`: Linux / WSL2-only local development middle ground. Commands still run with host tooling, but bwrap narrows the visible filesystem and process environment with bind mounts and namespaces. It is not available to native macOS or Windows hosts; use the Docker backend there. Use this when local execution is useful but fully naked host execution is not acceptable. It is experimental, explicit opt-in only, and not selected by `auto`. Network is inherited by default; set `AGENT_BWRAP_NETWORK_MODE=none` to add `--unshare-net` when the host supports it.
- `local`: filesystem-only fallback. It relies on deepagents/backend path routing and this package's bounded file operations; it can read and write allowed material views but should not be treated as an execution sandbox. Its safety comes from having little capability, not from process isolation.

`AGENT_SANDBOX_BACKEND=auto` remains Docker -> local. Use `AGENT_SANDBOX_BACKEND=bwrap` only when the host has been checked and the caller accepts the host-policy dependency.

This repository intentionally does not maintain Linux / WSL2 `bwrap` host setup instructions; use the [Codex Sandbox prerequisites](https://developers.openai.com/codex/concepts/sandboxing/#prerequisites) as the external reference.

## LangChain And DeepAgents Boundary

LangChain provides `ShellToolMiddleware`, and its packaging is useful. It exposes a persistent shell session, supports startup and shutdown commands, handles timeouts and output limits, and can run through host, Docker, or Codex sandbox execution policies. It is a strong fit for early demos because it quickly gives an agent the edit-run-observe loop that engineering workflows need.

This project does not use `ShellToolMiddleware` as the default execution path because shell execution alone does not provide the agent-visible virtual filesystem contract this package needs. Material views, route-aware path mapping, writable-root control, large-result artifact paths, and stage patch reconciliation all need to agree on the same workspace boundary.

DeepAgents `FilesystemMiddleware` is closer to the desired workspace shape. It provides structured file tools, but its default backend does not provide the `execute` capability. `execute` appears only when the backend implements `SandboxBackendProtocol`.

This project follows that logic by implementing `SandboxBackendProtocol` backends for the execution-capable cases. The Docker backend is the Docker-based execution backend. The bwrap backend is the Bubblewrap-based local isolation execution backend.

## Local Hardening Over Upstream

LangChain and DeepAgents provide useful shapes, but their default filesystem and shell pieces are not enough for this project's safety and workflow needs. This package intentionally strengthens those pieces locally instead of treating upstream behavior as sufficient.

Across the local, Docker, and bwrap backends, the important hardening points are bounded reads and search, ignored-directory pruning, deterministic truncation, explicit writable policy, symlink non-traversal, and newline-tolerant edits. Docker and bwrap also carry those filesystem promises into execution-capable sandboxes, rather than treating command execution as a separate path with weaker workspace rules.

These hardening points cannot be added reliably by calling upstream helpers first and applying limits afterward; traversal and edit behavior must be controlled while the operation runs. The initial improvement therefore forked the relevant upstream implementation shape into project-owned code. The benefit is that these guarantees are enforced directly in this package. The cost is maintenance: periodically compare LangChain and DeepAgents implementations for useful fixes or simplifications worth bringing back here.

## Codex As A Reference

Codex is a reference for platform-specific sandboxing: it uses [Seatbelt-style Apple sandboxing](https://developer.apple.com/documentation/security/app-sandbox) on macOS, [Bubblewrap](https://github.com/containers/bubblewrap) on Linux and WSL2, and the native Windows sandbox in PowerShell. See the [Codex Sandbox documentation](https://developers.openai.com/codex/concepts/sandboxing/).

This package learns from that platform split but currently implements Docker, local, and Linux / WSL2 `bwrap` backends only. It does not implement a native macOS Seatbelt backend or a native Windows sandbox.

If a product does not want to implement platform sandbox adapters such as `bwrap` and Seatbelt, it can use [Sandbox Agents in the OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents/sandboxes/) and inspect the [openai/openai-agents-python](https://github.com/openai/openai-agents-python) source and examples. Sandbox Agents separate the agent harness from sandbox compute and support hosted sandbox providers as well as Docker and Unix-local clients. The application still owns its workflow and provider choice; this is an architectural alternative, not another backend in this package.
