# Windows Services And Named-Pipe Authority

- A named pipe is a securable object. Check the pipe security descriptor, the connecting client's token and whether remote clients are possible.
- Pipe-server impersonation changes the thread security context. Verify the negotiated impersonation level, use of the client token for the protected operation and reliable `RevertToSelf` on all paths.
- A service's logon account supplies its process token; service-object permissions separately control who may start, stop or change configuration. `SERVICE_CHANGE_CONFIG` can redirect a privileged service executable.
- Keep service identity, pipe access and downstream authorization distinct. Running as LocalSystem or accepting only “local” clients does not establish a trusted caller.

Report only a concrete unauthorized pipe operation, retained impersonation context or service-control right with security impact.
