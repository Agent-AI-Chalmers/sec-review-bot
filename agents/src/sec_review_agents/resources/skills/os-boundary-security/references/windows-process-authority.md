# Windows Process Authority And Inheritance

- Establish which primary token starts the child and whether the code uses the current process token, `CreateProcessAsUser`, `CreateProcessWithTokenW` or another explicit credential path.
- Trace inherited handles separately from environment and command-line input. `bInheritHandles`, each handle's inheritability and any explicit handle list determine what capabilities cross the process boundary.
- A handle can carry authority to files, pipes, processes, tokens or other kernel objects even when the child cannot reopen the object by name.
- Verify the exact creation flags, startup attributes, token rights, integrity level and job or sandbox constraints. A different user name or nominal low-privilege executable does not prove that privileged handles were removed.

Report only when a less-trusted child receives a usable token or handle capability beyond its intended authority, or when attacker-controlled process input is consumed with that authority. Missing generic process hardening alone is not a finding.
