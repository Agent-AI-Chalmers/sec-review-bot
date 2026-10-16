# OS Boundary Security Source Notes

Reviewed 2026-10-16. Guidance is Linux/POSIX-oriented. No Windows token, ACL, object-manager or named-pipe equivalence is claimed.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| OS-1: checked name versus object; `filesystem-resolution.md` | [Linux access(2)](https://man7.org/linux/man-pages/man2/access.2.html), NOTES | A prior pathname check can be invalid for a later operation. A race still requires a feasible competing writer. |
| OS-2: constrained resolution; `filesystem-resolution.md` | [Linux openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html), DESCRIPTION and `RESOLVE_*` | Resolution flags can constrain lookup. Verify exact flags; a handle or final-component no-follow alone is not equivalent. |
| OS-3: process credentials; `process-authority-inheritance.md` | [credentials(7)](https://man7.org/linux/man-pages/man7/credentials.7.html); [execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html), DESCRIPTION | Establish real/effective/saved IDs, groups and exec transitions. A nominal privilege drop does not prove authority removal. |
| OS-4: inherited state; `process-authority-inheritance.md` | `execve(2)`, Effect on process attributes and NOTES | Verify preserved descriptors and environment, including close-on-exec. A fixed executable does not establish safe inheritance. |
| OS-5: local IPC identity; `local-ipc.md` | [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html), pathname permissions, abstract sockets and `SO_PEERCRED` | Abstract sockets lack pathname permission controls. “Local” does not imply trusted. |
| OS-6: restriction scope; `process-authority-inheritance.md` | [Linux no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html), guarantees and limits | `no_new_privs` blocks specific exec-time gains; it is not a complete sandbox. |

Project policy requires a concrete unauthorized operation, retained capability or identity-confusion path. Missing sandbox hardening alone remains non-confirmed.

## Coverage and deferred work

Current coverage: Linux pathname resolution, process credentials and exec inheritance, Unix-domain socket permissions and peer identity. Deferred: Windows security tokens and ACLs, namespaces, seccomp policy design, container escape catalogs, capabilities and mandatory-access-control policy packs. `no_new_privs` is included only to prevent treating it as a complete sandbox.
