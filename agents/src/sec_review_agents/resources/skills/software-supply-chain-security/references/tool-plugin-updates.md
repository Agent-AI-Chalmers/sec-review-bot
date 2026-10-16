# Downloaded Tools, Plugins And Updates

- Trace the update or plugin channel from metadata discovery through artifact download, identity/integrity verification, version/freshness checks and execution.
- A checksum fetched from the same attacker-controlled channel does not independently authenticate the artifact. Establish the trusted root or expected signer identity.
- Prevent rollback or freeze only when the update contract requires freshness; verify signed version/expiry or equivalent trusted state rather than comparing untrusted version strings.
- Plugin catalogs, IDE extensions, compiler plugins and downloaded build tools are code-execution paths even when they are not application dependencies.

Do not maintain product-specific updater lists. Report a concrete attacker-controlled channel or rollback path that reaches execution with developer, build or deployment authority.
