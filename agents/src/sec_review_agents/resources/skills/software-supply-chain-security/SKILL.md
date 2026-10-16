---
name: software-supply-chain-security
description: "Use when repository security depends on which dependency source or package version a resolver selects, or whether install/build lifecycle code executes with developer or build authority. It does not replace CI artifact review or dependency-vulnerability triage."
---

# Software Supply Chain Security

- For registry choice, source precedence, package identity, namespace ownership, candidate versions and lock enforcement: read `/skills/software-supply-chain-security/references/dependency-selection.md`.
- For package-manager lifecycle scripts, source builds, plugins and code executed during dependency installation or build: read `/skills/software-supply-chain-security/references/install-build-execution.md`.
- For Cargo registries/source replacement and `build.rs`: read `/skills/software-supply-chain-security/references/cargo-dependencies.md`.
- For Maven/Gradle repositories, build plugins and initialization code: read `/skills/software-supply-chain-security/references/jvm-build-dependencies.md`.
- For Go module proxies, `GOPRIVATE`, checksum verification and replacements: read `/skills/software-supply-chain-security/references/go-modules.md`.
- For provenance subject, signer/builder identity and consumer policy verification: read `/skills/software-supply-chain-security/references/provenance-verification.md`.
- For downloaded tools, plugins and automatic updates crossing into execution: read `/skills/software-supply-chain-security/references/tool-plugin-updates.md`.

Establish the actual package manager/version, configuration, resolver inputs, selected artifact and execution command. Missing pinning, an SBOM or provenance alone is not a confirmed repository vulnerability.
