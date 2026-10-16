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

The 19 added JSON cases produced 12 prompted and 7 path-unprompted runs with `deepseek-v4-pro` on 2026-10-16. These runs established resource readability and agreement with the then-current lightweight verdict/keyword oracle. They do not independently validate the references, and the path-unprompted cases do not establish routing from realistic repository code. One ambiguous JSON-signature case selected parser security and was replaced with a narrower signature-encoding/replay case rather than forcing a disputed owner.

A subsequent depth pass added X.509 path/service-identity rules, HTTP/2 validation and translation, and Java happens-before/publication semantics. It also added cases for Web CSRF, Web file serving, and GitLab fork/parent pipelines. The original 12 prompted and 6 path-unprompted runs showed that the model could read the selected resources and match the lightweight oracle; they were not independent correctness evidence. The former one-case-per-reference gate was removed because it rewarded placeholder cases rather than decision-changing tests.

An independent correctness review then found three invalid or under-specified cases and an overclaim in the test evidence. The confused-deputy case was rewritten around a broker's independent organization-wide credential and missing delegated target/operation binding. The Windows impersonation case now establishes a repeatable availability impact from a retained low-privilege thread token. The Cargo case now uses an explicit alternate registry, an update command, an admissible version and recorded resolver selection rather than misusing source replacement. Stronger cases can require multiple independent explanation concepts and named proof gaps; deterministic tests ensure every listed requirement is enforced. Legacy single-regex fixtures remain weaker historical checks and are not counted as independent correctness evidence.
