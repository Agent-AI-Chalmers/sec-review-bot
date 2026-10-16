# Filesystem Resolution Authority

- Constrain the actual filesystem operation and resolution, not only a previously checked pathname. Prove whether untrusted actors can replace relevant components between check and use.
- Verify the exact resolution API and flags. A final-component no-follow option or directory handle does not automatically constrain every component.
Linux APIs are not portable prescriptions. A stable constrained operation is a counterexample.
