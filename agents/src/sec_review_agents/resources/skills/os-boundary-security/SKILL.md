---
name: os-boundary-security
description: "Use for process invocation, filesystem path authority, OS-enforced credentials and inheritance, and local IPC trust. Common process/path rules are cross-platform concepts; API-specific guidance states its platform limits."
---

# OS Boundary Security

- For attacker-influenced filenames or paths reaching filesystem reads, writes, deletion, serving, extraction, or path-based authorization: read `/skills/os-boundary-security/references/filesystem-path-policy.md`.
- For Linux pathname resolution, symlinks, directory handles and binding checks to actual filesystem objects: read `/skills/os-boundary-security/references/filesystem-resolution.md`.
- For attacker-influenced command strings, executable selection, child arguments, environment, configuration, or working directory: read `/skills/os-boundary-security/references/process-execution-input.md`.
- For process credentials, privilege transitions, executable authority and inherited descriptors/environment: read `/skills/os-boundary-security/references/process-authority-inheritance.md`.
- For Unix-domain socket permissions, abstract sockets and peer identity: read `/skills/os-boundary-security/references/local-ipc.md`.
- For Windows path namespaces, reparse points, file security descriptors and token-based access checks: read `/skills/os-boundary-security/references/windows-filesystem-authority.md`.
- For Windows process tokens, explicit credential changes and inherited handles: read `/skills/os-boundary-security/references/windows-process-authority.md`.

Verify the target OS, command parser, API flags, credentials and repository deployment assumptions. Names such as “local”, “sandboxed” or “privilege dropped” do not establish the boundary.
