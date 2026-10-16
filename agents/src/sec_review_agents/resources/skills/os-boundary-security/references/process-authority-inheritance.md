# Process Authority And Inheritance

- Establish real, effective and saved user/group IDs plus supplementary groups for each relevant operation. A nominal privilege-drop call does not prove that authority cannot be regained or retained elsewhere.
- Inspect executable selection, interpreter behavior and credential changes across `execve`. Verify set-ID, filesystem, tracing and `no_new_privs` conditions from the actual Linux environment.
- Identify security-relevant file descriptors and environment inherited by a child. Confirm close-on-exec and explicit environment construction where isolation depends on them.
- A fixed executable path does not make inherited descriptors, loader configuration or environment harmless.

Report the concrete retained or regained authority and the path that exposes it. Intentional delegation with constrained consumers is a counterexample; `no_new_privs` alone is not a complete sandbox.
