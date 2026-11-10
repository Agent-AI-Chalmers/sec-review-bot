# Filesystem Backends

This package owns the agent-visible filesystem and command-execution backends. It describes the boundary between upstream file operations and project-owned routing, permissions, and Docker execution.

## Backend Shape

- `docker`: service-side and benchmark-oriented execution sandbox. Use this when running other people's code should not happen directly on the host, when a stage needs a pinned image, or when tooling must be reproducible across machines. This is the normal backend for execution-heavy analyzer / mitigation / verification paths.
- `local`: filesystem-only backend with no command execution. It relies on DeepAgents file operations and this package's path routing and writable-mount policy; it can read and write allowed material views but is not an execution sandbox. Its safety comes from having little capability, not from process isolation. Agents that need no shell select it directly; it is not reachable through `AGENT_SANDBOX_BACKEND`, so a stage that runs commands never receives it by configuration.

Docker is the only execution backend. `AGENT_SANDBOX_BACKEND` may be unset or `docker`; other values fail rather than falling back to another runtime.

## LangChain And DeepAgents Boundary

LangChain provides `ShellToolMiddleware`, and its packaging is useful. It exposes a persistent shell session, supports startup and shutdown commands, handles timeouts and output limits, and can run through host, Docker, or Codex sandbox execution policies. That makes it a good fit for early demos, since it quickly gives an agent the edit-run-observe loop that engineering workflows need.

This project does not use `ShellToolMiddleware` as the default execution path because shell execution alone does not provide the agent-visible virtual filesystem contract this package needs. Material views, route-aware path mapping, writable-root control, large-result artifact paths, and stage patch reconciliation all need to agree on the same workspace boundary.

DeepAgents `FilesystemMiddleware` is closer to the desired workspace shape. It provides structured file tools, but its default backend does not provide the `execute` capability. `execute` appears only when the backend implements `SandboxBackendProtocol`.

The Docker backend implements `SandboxBackendProtocol`; the local filesystem backend does not expose command execution.

## Project-Owned Hardening

LangChain and DeepAgents provide the backend interfaces we build on, but their default filesystem and shell implementations do not enforce all of this project's safety requirements.

<!-- doc-default: LocalFilesystemBackend; source=agents/src/sec_review_agents/filesystem/local_backend.py -->

Local file operations reuse `FilesystemBackend`. Docker reuses `BaseSandbox` for reading, searching, writing, editing, and deletion. Directory listing uses a small project-owned helper because upstream uses an `os.scandir` context manager unavailable in Python 3.5. Project wrappers enforce allowed paths and writable views; Docker also translates between agent-visible and container paths. File-operation limits, glob matching, pagination, and newline semantics follow the installed DeepAgents version rather than a project-owned fork.

<!-- doc-default: DockerSandboxBackend; source=agents/src/sec_review_agents/filesystem/docker_backend.py -->

Docker always provides writable container-native `/tmp`, independently of repository material views. Upstream large edits upload their payloads there; no project-owned edit staging or replacement script is retained. `/tmp` must not be remapped to a host directory or made read-only through a material view. Docker regular-file transfers retain directory-file-descriptor resolution, `O_NOFOLLOW`, and non-blocking type checks. Project-owned container helpers support Python 3.5 and later; the host worker still uses Python 3.14.

Docker adds process isolation. It uses network and mount namespaces, `no-new-privileges`, a reduced capability set, and configurable PID, memory, and CPU limits. Docker also applies its daemon-provided seccomp and AppArmor defaults when available. A deployment can require named policies with `AGENT_DOCKER_SECCOMP_PROFILE` and `AGENT_DOCKER_APPARMOR_PROFILE`; a missing or rejected configured profile fails container startup.

<!-- doc-default: AGENT_COMMAND_TIMEOUT_MS; source=agents/src/sec_review_agents/filesystem/limits.py -->

Command execution uses a ten-minute timeout for Docker. Deployments may override it with `AGENT_COMMAND_TIMEOUT_MS`. Timeouts and output truncation are application safeguards, not resource quotas. Availability probes establish only that the configured baseline can start; integration tests own policy claims such as network isolation, read-only routes, private `/tmp`, symlink-safe transfers, and resource limits.

Dependency upgrades must exercise route mapping, mutation permissions (including newly inherited operations), and large-edit staging. Upstream file-operation behavior is accepted; isolation and transfer protections remain project responsibilities.

## Runtime And Dependencies

The Docker image supplies the runtime and dependencies. Each run uses its own container, which persists across commands until cleanup. Workspace setup and tools therefore run in the same environment. Host bind mounts supply repository material rather than an alternative runtime.
