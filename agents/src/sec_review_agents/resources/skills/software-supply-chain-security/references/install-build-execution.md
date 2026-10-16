# Dependency Install And Build Execution

- Trace code executed by the actual install or build command: package lifecycle scripts, source builds, compiler/build plugins, hooks and generated tooling can run before application runtime imports anything.
- For npm, lifecycle scripts such as `preinstall`, `install`, `postinstall` and dependency `prepare` behavior depend on package source and CLI behavior. Verify the installed package, command, npm version and whether scripts are disabled.
- Treat `--ignore-scripts` or an equivalent control according to the package manager's documented scope. It does not establish package identity, and a safe resolver does not establish that selected package build code is harmless.
- Identify the authority available during installation: developer files, CI secrets, package publishing tokens, caches and build outputs. A script in a trusted first-party package is not automatically malicious or unauthorized.

Report only when attacker-influenced dependency content reaches an enabled install/build execution path with authority or data beyond the attacker's entitlement. A lockfile entry or unused runtime import is insufficient by itself.
