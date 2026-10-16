# Local IPC Trust

- “Local” does not imply trusted. Establish who can create, connect to or replace the endpoint and how the server binds a request to a peer identity.
- Pathname Unix sockets can use filesystem ownership and permissions; Linux abstract sockets do not inherit pathname permission controls.
- Verify peer-credential APIs against the accepted connection and the principal relevant to the authorization decision.

Do not confirm an IPC boundary failure from endpoint type alone. Require reachable unauthorized access or a concrete identity-confusion path.
