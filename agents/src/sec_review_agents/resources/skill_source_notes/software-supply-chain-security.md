# Software Supply Chain Security Source Notes

Reviewed 2026-10-16. The bundled skill is limited to dependency candidate selection and code executed during install/build. CI artifact promotion remains in `ci-security`; dependency-CVE reachability remains in `scanner-finding-triage`; cryptographic verification remains in `cryptography-security`.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| SUPPLY-1: pip candidate sources; `dependency-selection.md` | [pip install](https://pip.pypa.io/en/stable/cli/pip_install/), “Finding Packages” and the `--extra-index-url` warning | A public candidate can substitute for an intended private package when the actual pip configuration permits it. Do not generalize pip selection to other ecosystems or report multiple indexes without an attacker-publishable candidate. |
| SUPPLY-2: lock enforcement; `dependency-selection.md` | [pip Secure Installs](https://pip.pypa.io/en/stable/topics/secure-installs/), hash checking and pinned dependencies; [npm package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) | Determine whether the actual command consumes the reviewed lock/hash data. Lockfile presence alone does not establish source identity or execution behavior. |
| SUPPLY-3: npm lifecycle execution; `install-build-execution.md` | [npm scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/), lifecycle scripts and operation order | Dependency code can execute during install/build before runtime import. Verify package source, selected version, command and enabled scripts. |
| SUPPLY-4: disabling scripts; `install-build-execution.md` | [npm config `ignore-scripts`](https://docs.npmjs.com/cli/v11/using-npm/config#ignore-scripts) | `ignore-scripts` changes lifecycle execution within its documented scope; it does not establish package identity or safety in other tools. |
| SUPPLY-5: provenance boundary | [SLSA v1.2 Threats Overview](https://slsa.dev/spec/v1.2/threats-overview) | Provenance and promotion are not in the first bundled references. Presence of an attestation is not proof that the consumer verifies the intended identity/policy; CI owns artifact production/promotion authority. |

Project policy requires an attacker-influenced selectable dependency or install/build execution path and concrete authority or code-consumption effect. Missing pinning, SBOM, provenance or a preferred package-manager setting alone remains non-confirmed.

Behavior cases for dependency selection: `supply-dependency-confusion` (confirmed and natural discovery), `supply-private-source-enforced` (counterexample), and `supply-unknown-resolver` (unresolved boundary). Behavior cases for install/build execution: `supply-install-script-execution` (confirmed and natural discovery), `supply-install-scripts-disabled` (counterexample), and `supply-install-unknown` (unresolved boundary). All six passed with the deployed integration model on 2026-10-16; this is local evidence, not a general quality estimate.

## Coverage and deferred work

Current coverage: pip-style competing-source selection, lock/hash enforcement questions, and npm lifecycle execution. Deferred: Cargo, Maven/Gradle, Go modules, downloaded-tool update channels, maintainer-account compromise, provenance verification policy and malicious trusted producers. Add ecosystem references only when repository demand and first-party specifications justify them.
