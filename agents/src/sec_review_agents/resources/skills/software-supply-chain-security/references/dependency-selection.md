# Dependency Source And Candidate Selection

- Identify every configured package source, its trust owner, authentication, namespace rules and how the actual resolver combines or prioritizes candidates.
- For pip, `--extra-index-url` is unsafe for private packages when a public index can provide a higher-priority candidate with the same name. Verify the exact package name, available versions and command/configuration; multiple indexes alone are only a lead.
- Establish whether a reviewed lockfile or hash-checked artifact fixes both identity and content for the installation command actually used. Lockfile presence is not proof when the command re-resolves, ignores it or selects another source.
- Distinguish an attacker-publishable namespace from an authenticated private source. A single enforced source or reserved public namespace is a counterexample when repository evidence establishes it.

Report only when an attacker can supply a selectable candidate that the repository's real resolver can choose, producing unauthorized code or artifact consumption. Do not generalize pip precedence to npm, Cargo or other ecosystems.
