# CI Secret And Artifact Exposure

Use this reference when CI/CD execution can copy credentials or sensitive values into logs, build output, caches, container layers, packages, attestations, or downloadable artifacts.

## Trace The Boundary

- Identify the secret or sensitive value and how the job receives it.
- Identify the exact command, expansion, file copy, build step, cache rule, upload step, or image layer that publishes it.
- Establish who can trigger the job and who can read the resulting log or artifact.
- Treat untrusted repository content, build scripts, package hooks and test output as possible paths to a secret-bearing job's outputs.

## Guards

- Secret masking reduces accidental log disclosure but does not protect transformed values, files, artifacts, caches, or attacker-controlled exfiltration.
- Artifact retention and access controls limit readers; verify their actual scope rather than treating every uploaded artifact as public.
- Multi-stage builds and cleanup do not remove a secret from an earlier published layer or cache entry.
- A secret available to a job is only a lead. Confirm that untrusted code can read it or that a concrete step publishes it.

## Report Conditions

Report only when repository evidence establishes a plausibly live secret or security-relevant sensitive value, a reachable publication path, an unauthorized reader, and the resulting privilege or follow-on access.

Placeholder values, secret-shaped variable names, ordinary non-sensitive build metadata, and private artifacts with no unauthorized reader are not confirmed exposure.
