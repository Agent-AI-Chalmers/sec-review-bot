# OS Boundary Security Source Notes

Reviewed 2026-10-16. Process-input and path-policy principles are cross-platform, while API claims are explicitly Linux/POSIX-oriented. No Windows token, ACL, object-manager or named-pipe equivalence is claimed.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| OS-1: checked name versus object; `filesystem-resolution.md` | [Linux access(2)](https://man7.org/linux/man-pages/man2/access.2.html), NOTES | A prior pathname check can be invalid for a later operation. A race still requires a feasible competing writer. |
| OS-2: constrained resolution; `filesystem-resolution.md` | [Linux openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html), DESCRIPTION and `RESOLVE_*` | Resolution flags can constrain lookup. Verify exact flags; a handle or final-component no-follow alone is not equivalent. |
| OS-3: process credentials; `process-authority-inheritance.md` | [credentials(7)](https://man7.org/linux/man-pages/man7/credentials.7.html); [execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html), DESCRIPTION | Establish real/effective/saved IDs, groups and exec transitions. A nominal privilege drop does not prove authority removal. |
| OS-4: inherited state; `process-authority-inheritance.md` | `execve(2)`, Effect on process attributes and NOTES | Verify preserved descriptors and environment, including close-on-exec. A fixed executable does not establish safe inheritance. |
| OS-5: local IPC identity; `local-ipc.md` | [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html), pathname permissions, abstract sockets and `SO_PEERCRED` | Abstract sockets lack pathname permission controls. “Local” does not imply trusted. |
| OS-6: restriction scope; `process-authority-inheritance.md` | [Linux no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html), guarantees and limits | `no_new_privs` blocks specific exec-time gains; it is not a complete sandbox. |
| OS-7: command and argument interpretation; `process-execution-input.md` | [OWASP OS Command Injection Defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html), “Argument Injection” and defense options; [CWE-78](https://cwe.mitre.org/data/definitions/78.html) | Avoiding a shell removes shell parsing but does not make attacker-selected executable names, flags, configuration or other child-parser semantics safe. Confirm the actual child grammar and an authority boundary. |
| OS-8: single-element option syntax; `process-execution-input.md` | [Python 3.14 argparse](https://docs.python.org/3.14/library/argparse.html), option value syntax | A single `--flag=value` argv element can be an option under Python `argparse`. This supports the fixture and is not a claim about every child parser. |
| OS-9: path containment; `filesystem-path-policy.md` | [CWE-22](https://cwe.mitre.org/data/definitions/22.html), Description and mitigations; [CWE-73](https://cwe.mitre.org/data/definitions/73.html), Description | Trace attacker-controlled path components to the actual filesystem operation and its containment policy. String joining or a path-shaped value alone is insufficient. |
| OS-10: archive entries; `filesystem-path-policy.md` | [SEI CERT IDS04-J](https://wiki.sei.cmu.edu/confluence/display/java/IDS04-J.+Safely+extract+files+from+ZipInputStream), compliant solution | Extraction must keep entries within the destination and account for extraction behavior. Apply platform and archive-library semantics; do not infer exploitability from an archive API alone. |

Project policy requires a concrete unauthorized operation, retained capability or identity-confusion path. Missing sandbox hardening alone remains non-confirmed.

## Coverage and deferred work

Current coverage: process-input semantics, filesystem path containment, Linux pathname resolution, process credentials and exec inheritance, and Unix-domain socket permissions and peer identity. Deferred: Windows security tokens and ACL APIs, namespaces, seccomp policy design, container escape catalogs, capabilities and mandatory-access-control policy packs. `no_new_privs` is included only to prevent treating it as a complete sandbox.
