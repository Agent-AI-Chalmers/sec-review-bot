---
name: os-boundary-security
description: "Use for OS-enforced filesystem and process authority, credential transitions, descriptor or environment inheritance, and local IPC peer trust. Initial guidance is Linux/POSIX-oriented and must not be assumed portable."
---

# OS Boundary Security

- For pathname resolution, symlinks, directory handles and binding checks to actual filesystem objects: read `/skills/os-boundary-security/references/filesystem-resolution.md`.
- For process credentials, privilege transitions, executable authority and inherited descriptors/environment: read `/skills/os-boundary-security/references/process-authority-inheritance.md`.
- For Unix-domain socket permissions, abstract sockets and peer identity: read `/skills/os-boundary-security/references/local-ipc.md`.

Verify the target OS, API flags, credentials and repository deployment assumptions. Names such as “local”, “sandboxed” or “privilege dropped” do not establish the boundary.
