# Security Coverage Decisions

Reviewed 2026-10-16. This document records security-domain packaging and ownership decisions. It is separate from source notes, which only trace operational rules to authoritative sources and state applicability limits. The first admission filter is whether a rule is stable enough to maintain. A stable rule is admitted only when it also changes a security decision beyond ordinary workflow source/sink, reachability and authority reasoning.

| Area | Decision | Reason and boundary |
| --- | --- | --- |
| Cargo, Maven/Gradle and Go modules | Merge into `software-supply-chain-security` | Their source-selection, integrity and build-execution rules are stable and independently affect review decisions. Package-manager defaults and version recommendation tables are excluded. |
| Windows named pipes and service permissions | Merge into `os-boundary-security` | They are OS authority, token, ACL and local-IPC mechanisms. Product service configurations and Windows-version default matrices are excluded. |
| JavaScript, Java/.NET and Go cancellation | Merge into `concurrency-resource-security` | Cooperative cancellation and retained-work semantics are stable per runtime and change resource-leak judgments. Minor API defaults still require the repository version. |
| Signature encoding, canonicalization and malleability | Merge into `cryptography-security` | Exact signed bytes and scheme-required checks are stable. Universal low-S, canonical-JSON and algorithm recommendation rules are explicitly rejected. |
| Provenance generation, verification and consumption | Split ownership | CI owns production/promotion authority. Supply-chain security owns consumer binding of subject, identity and policy. Missing provenance alone is not a vulnerability. |
| Downloaded tools, plugins and update channels | Merge into `software-supply-chain-security` | Trust-root, channel, freshness and execution rules are stable. Product updater catalogs and current-version feeds are excluded. |
| Archives, templates and expression interpreters | Merge into `parser-protocol-security` | Archive-controlled structure and code-like interpreter structure have stable decision rules. Filesystem landing authority remains in OS security. Media/codec vulnerability catalogs are excluded. |
| Non-Web service identity, delegation and confused deputies | Add `authorization-delegation-security` | The actor/subject/audience/scope/target model changes authorization judgments and has stable protocol/taxonomy support. It is distinct from browser sessions and cryptographic verification. |

## Reference scope decisions

- `memory-numeric-safety` covers integer conversions, allocation/access units, lifetime, invalid frees, unsafe validity, and FFI layout/ownership. Language allocator internals, hardware memory tagging, speculative execution, and exhaustive undefined-behavior catalogs are outside the bundled scope.
- `cryptography-security` covers mode/key/nonce contracts, verification, password verifiers, KDF separation, signature representation, and core certificate path/service identity rules. Key-management operations need narrower review before admission; live TLS and algorithm recommendation matrices are excluded.
- `concurrency-resource-security` covers temporal invariants, attacker-driven resource budgets, cleanup/cancellation for selected runtimes, and focused Java publication semantics. Other language memory models need their own specifications. Lock-order catalogs and distributed-consensus correctness are not bundled domains.
- `os-boundary-security` covers process input, filesystem authority, Linux credentials/inheritance and local IPC, plus focused Windows filesystem, process, service, and named-pipe authority. AppContainer, namespaces, seccomp, capabilities, mandatory access control, and container-escape catalogs are not generic bundled references.
- `parser-protocol-security` covers representation gaps, HTTP/1.1 framing, HTTP/2 validation/translation, XML capabilities, object construction, archive structure, expression interpreters, and token-context substitution. HTTP/3, gRPC, and protocol state/replay need protocol-specific admission; media vulnerability catalogs and parser-default matrices are excluded.
- `software-supply-chain-security` covers selected package ecosystems, install/build execution, provenance consumption, and tool/plugin/update trust. Maintainer compromise without a repository-controlled decision point remains workflow threat reasoning; product updater catalogs, live package-manager defaults, and vulnerability feeds are excluded.
- `authorization-delegation-security` covers service/workload identity, delegation, actor/subject distinction, and confused deputies. Browser authorization remains in Web security, OS token impersonation remains in OS boundary security, and certificate mechanics remain in cryptography. Product IAM catalogs and live identity-provider defaults are excluded.

## Explicit non-skill material

- Workflow reasoning owns ordinary source-to-sink tracing, reachability, concrete impact, proof gaps and repository-specific business policy.
- `cwe` remains taxonomy/navigation; it does not define the reporting oracle or require a skill for every weakness class.
- `scanner-finding-triage` remains a method for validating tool output, not a security domain.
- Platform references may be selective and still belong in a general skill. They must state their platform/version limits.
- Live vulnerability catalogs, product defaults, deprecation schedules and evergreen recommendation lists are excluded from bundled knowledge because they age quickly. When a review depends on them, obtain current primary documentation rather than freezing them into a skill.
