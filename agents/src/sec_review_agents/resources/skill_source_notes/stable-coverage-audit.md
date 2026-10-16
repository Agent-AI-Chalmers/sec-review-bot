# Stable Security Coverage Audit

Reviewed 2026-10-16. This ledger records the systematic disposition of the remaining proposed areas. The first filter is whether the rule is stable enough to maintain. A stable rule is admitted only when it also changes a security decision beyond ordinary workflow source/sink, reachability and authority reasoning.

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

## Explicit non-skill material

- Workflow reasoning owns ordinary source-to-sink tracing, reachability, concrete impact, proof gaps and repository-specific business policy.
- `cwe` remains taxonomy/navigation; it does not define the reporting oracle or require a skill for every weakness class.
- `scanner-finding-triage` remains a method for validating tool output, not a security domain.
- Platform references may be selective and still belong in a general skill. They must state their platform/version limits.
- Live vulnerability catalogs, product defaults, deprecation schedules and evergreen recommendation lists are excluded from bundled knowledge because they age quickly. When a review depends on them, obtain current primary documentation rather than freezing them into a skill.

The 19 added JSON cases cover these admitted groups with 12 prompted and 7 natural runs. All passed with `deepseek-v4-pro` on 2026-10-16 and every natural run read the expected skill and reference. One initially ambiguous JSON-signature case naturally selected parser security; it was replaced with a protocol-defined signature-encoding/replay case rather than forcing a disputed owner. This is local routing and judgment evidence, not a claim of general model improvement.

A subsequent depth pass added stable X.509 path/service-identity rules, HTTP/2 validation and translation, and Java happens-before/publication semantics. It also filled the previously missing behavior coverage for Web CSRF, Web file serving, and GitLab fork/parent pipelines. The 18 added cases comprise 12 prompted and 6 natural runs; all passed with `deepseek-v4-pro` on 2026-10-16 and every natural run read the expected skill and reference. A deterministic test now prevents new bundled domain references from being added without at least one maintained JSON oracle.
