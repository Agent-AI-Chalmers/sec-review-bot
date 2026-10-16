# Security Coverage Candidate Source Notes

## Status and evidence contract

Research notes reviewed 2026-10-16. No candidate in this file has been bundled or behaviorally validated. The scope decisions are engineering hypotheses, not conclusions derived from evaluation outcomes. PatchEval cases, CWE distributions, patches, tests, failures and results are excluded from requirement selection and probe design. PatchEval is reserved for final evaluation after freezing the skills.

Each row records a rule group, a primary source locator, and the limit of the proposed inference. A taxonomy entry establishes a failure mechanism, not that the mechanism needs a standalone skill. Keep rule groups small enough to have a meaningful counterexample. Record source revision or review date and applicability; recheck a live source or API default against the repository version when material. These notes are outside the mounted skill view.

There is no requirement to trace every connective sentence. Trace decision-changing rules: report/reject conditions, guard sufficiency, platform defaults, and exceptions. Project choices about workflow, reporting thresholds, ownership, and packaging must be identified as project policy rather than attributed to a standard.

## memory-numeric-safety

| ID | Candidate operational claim | Primary support and locator | Scope and counterexample |
| --- | --- | --- | --- |
| MEM-1 | Establish operand types, conversions and arithmetic behavior before deciding that a check bounds the value later consumed. | [CERT C Integers](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/), INT30-C, INT31-C, INT32-C; [Rust operators](https://doc.rust-lang.org/reference/expressions/operator-expr.html#overflow), Overflow | C rules are not cross-language semantics. Checked rejection or intentional bounded wrapping is not automatically a flaw. Verify integer width, promotions and build options. |
| MEM-2 | Trace element count, byte count and allocation/access bounds in compatible units. | [CERT C Memory Management](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/), MEM35-C | A length field alone is not a bug. The relevant relationship is allocation capacity versus the actual access, including earlier validation. |
| MEM-3 | Check lifetime, initialization and object validity, including unsafe/FFI boundaries. | Same CERT source, MEM30-C, MEM34-C; [Rust undefined behavior](https://doc.rust-lang.org/reference/behavior-considered-undefined.html), dangling/misaligned pointers, data races, invalid values and foreign ABI | An `unsafe` block is not proof of a violation. Caller preconditions, ownership transfer, aliasing and representation must be established for the specific language/ABI. |
| MEM-4 | Numeric security consequences need not include memory access. | [CWE-704](https://cwe.mitre.org/data/definitions/704.html), Description and Common Consequences | Type-conversion failure can affect protection logic. Which quota, balance, timeout or range is security-sensitive remains repository-specific reasoning; this does not introduce a generic financial-rules checklist. |

Potential knowledge increment: invalidation of superficially correct range checks by conversion, units or ownership semantics. Proposed references: numeric semantics, bounds/allocation, object validity, unsafe/FFI. Generic “avoid overflow” advice is not sufficient content. First probe pair: a conversion before/after the same check changes the consumed value, contrasted with checked rejection. Behavior evidence: not yet collected.

## cryptography-security

| ID | Candidate operational claim | Primary support and locator | Scope and counterexample |
| --- | --- | --- | --- |
| CRYPTO-1 | Verify nonce/IV requirements for the actual mode and key scope; uniqueness and unpredictability are different requirements. | [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final), §§8 and 8.1, Appendix A | This source covers GCM/GMAC, not all modes. Do not generalize GCM IV requirements into a universal IV rule. A counter scoped uniquely to a key can satisfy uniqueness without being random. |
| CRYPTO-2 | Verify algorithm selection, key binding, all cryptographic operations, and failure handling before consuming an authenticated result. | [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), §§3.1–3.4 | JWT-specific examples support the verification contract, not universal “verify before every parse” advice. Some bounded parsing is needed to verify a message; distinguish it from acting on unverified claims. |
| CRYPTO-3 | Cryptographic validity is separate from identity and token-purpose authorization. | Same RFC, §§3.8–3.12 | Issuer/audience/type/session meaning belongs to the consumer's policy. Signature validation alone does not establish the intended user or relying party. No cross-skill loading instruction is needed. |
| CRYPTO-4 | Password verifier protection differs from using a fast generic hash. | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), §3.1.1.2 | Identify actual password storage and offline threat assumptions. A fast hash used as a non-security checksum is a counterexample. Avoid fixed work factors and algorithm-deprecation tables in the first skill. |
| CRYPTO-5 | Certificate path processing requires specific trust inputs and validation rules. | [RFC 5280](https://www.rfc-editor.org/rfc/rfc5280.html), §6 | A valid path is not a full TLS peer-identity decision. General PKI, revocation operations and TLS policy remain deferred until separately sourced and scoped. |

Potential increment: mode-specific preconditions, key/message scope and fail-open verification behavior. Proposed references: primitive contracts, key/randomness/nonce scope, verification and authenticated-result consumption. Rotation programs, universal algorithm recommendations and full certificate operations are excluded from the initial experiment. First probe pair: same-key nonce reuse versus correctly separated keys/counters. Behavior evidence: not yet collected.

## concurrency-resource-security

| ID | Candidate operational claim | Primary support and locator | Scope and counterexample |
| --- | --- | --- | --- |
| CON-1 | Reason about conflicting accesses, synchronization coverage and object lifetime, not lock presence. | [CERT C Concurrency](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/concurrency-con/), CON43-C and CON34-C | C data-race semantics do not define all language runtimes. Single-threaded execution does not exclude asynchronous or transactional interleaving. A correctly synchronized path is a negative example. |
| CON-2 | A check may become invalid before use if an actor can alter the checked state. | [CWE-367](https://cwe.mitre.org/data/definitions/367.html), Description and Potential Mitigations | Prove a feasible state change and the failing invariant. Separate check/use calls alone do not prove attacker control or a security effect. Filesystem authority details are OS semantics. |
| RES-1 | Evaluate attacker-induced consumption against actual resource limits and service effect. | [CWE-400](https://cwe.mitre.org/data/definitions/400.html), Description, consequences and mapping notes; [CWE-770](https://cwe.mitre.org/data/definitions/770.html), Description and mitigations | Missing timeout/limit alone is not proof. The project additionally requires a credible cost/amplification, rate, concurrency, capacity or recovery argument; exact production measurement is not always available. State unknown capacity rather than inventing it. |
| RES-2 | Cleanup and cancellation must cover reachable acquisition/error paths that can accumulate resources. | [CERT C Memory Management](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/), MEM31-C; CWE-400 | Memory cleanup is an example, not proof of uniform descriptor/task semantics. Bounded resources released by verified ownership/cleanup are a negative example. API-specific cancellation behavior requires its own primary documentation. |

Potential increment: temporal invariant versus finite-resource budget. Keep these as distinct references in one initial candidate; do not force both into one source/sink chain. First probes: feasible double-use versus atomic consume; unbounded retained work versus bounded admission and cleanup. Behavior evidence: not yet collected. Lock ordering and platform-specific cancellation need additional sources before operational guidance is adopted.

## os-boundary-security

Renames the proposed `system-boundary-security`; no existing bundled skill is renamed.

| ID | Candidate operational claim | Primary support and locator | Scope and counterexample |
| --- | --- | --- | --- |
| OS-1 | Filesystem policy must constrain the actual operation and resolution, not only a previously checked name. | [Linux access(2)](https://man7.org/linux/man-pages/man2/access.2.html), NOTES; [openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html), DESCRIPTION, resolution flags | Linux examples are not portable prescriptions. A stable constrained operation is a negative example; a handle name or final-component no-follow flag alone is not sufficient evidence. |
| OS-2 | Establish the credentials under which access and process operations actually occur. | [Linux credentials(7)](https://man7.org/linux/man-pages/man7/credentials.7.html), user/group IDs; [execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html), DESCRIPTION and NOTES | Distinguish real/effective/saved IDs and execution transitions. A nominal privilege-drop call is not proof that all relevant authority was removed. Windows ACL/token rules require separate first-party sources before inclusion. |
| OS-3 | Process execution can propagate security-relevant descriptors and environment. | Same execve source, “Effect on process attributes” and NOTES | Verify what is preserved or closed, including close-on-exec behavior. A fixed executable does not establish safe inheritance; an intentionally inherited capability is not automatically a leak. |
| OS-4 | Local IPC trust depends on endpoint permissions and peer identity semantics. | [Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html), “Pathname socket ownership and permissions”, “Abstract sockets”, `SO_PEERCRED` | Abstract sockets do not inherit pathname permission controls. OS-specific peer checks must match the connection and relevant principal. Do not infer that “local” means “trusted”. |
| OS-5 | A restriction on privilege gain has a specific scope, not a complete sandbox guarantee. | [Linux kernel no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html), documented guarantees and exceptions | Preventing exec-time privilege gain is not general isolation. Container, namespace and seccomp policy packs remain deferred, with no missing-hardening finding by default. |

Potential increment: object authority, process inheritance and identity transitions. First probe pair: attacker-writable path replaced between check/use versus operation constrained to the intended directory/object. Initial support is Linux/POSIX-oriented; no Unix/Windows parity claim. Behavior evidence: not yet collected.

## parser-protocol-security

| ID | Candidate operational claim | Primary support and locator | Scope and counterexample |
| --- | --- | --- | --- |
| PARSE-1 | Request framing ambiguity matters when recipients interpret the same stream differently. | [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html), §§6.3 and 11.2 | Require relevant receiver behavior/topology, not just malformed headers. Consistent rejection is a negative example. HTTP/2, HTTP/3 and gRPC are not automatically covered by HTTP/1.1 guidance. |
| PARSE-2 | Validation and consumption must agree about representation and meaning. | [CWE-20](https://cwe.mitre.org/data/definitions/20.html), Potential Mitigations, canonicalization guidance | Identify transformations and both interpretations. This is not “canonicalize repeatedly until safe”; format-specific policy and sink semantics still matter. |
| PARSE-3 | XML external-resource resolution and entity expansion are distinct capabilities with distinct impacts. | [OWASP XXE Prevention](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html), attack examples and parser-specific guidance | Verify actual parser features and defaults by version/configuration. Safe JSON parsing is not evidence of unsafe object reconstruction; a format name alone does not prove a dangerous capability. |
| PARSE-4 | Integrity and replay/context binding are different properties of message processing. | [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), §§2.7–2.8 and 3.8–3.12 | This supports token substitution/context confusion, not a universal protocol-state or anti-replay checklist. General protocol ordering/replay rules require the protocol's own specification before adoption. |

Potential increment: differential interpretation and cross-message invariants. Proposed references: representation/normalization, framing/differential parsing, dangerous parser capabilities; only add protocol-specific state guidance with its source. Memory legality and resource cost are separate questions, not mandatory subsequent skill loads. Archive, media and compiler are examples of consumers, not promises to cover every format. First probe pair: mismatched framing versus consistent rejection. Behavior evidence: not yet collected.

## software-supply-chain-security

Independent packaging is deferred; the narrow core remains under investigation.

| ID | Candidate operational claim | Primary support and locator | Scope and counterexample |
| --- | --- | --- | --- |
| SUPPLY-1 | Registry/source selection can permit an attacker-controlled package to replace the intended dependency. | [pip install](https://pip.pypa.io/en/stable/cli/pip_install/), “Finding Packages” and the `--extra-index-url` dependency-confusion warning | Verify namespace ownership, candidate selection, version and configuration. pip behavior must not be generalized to npm, Cargo or all registries. Multiple configured registries alone are not proof. |
| SUPPLY-2 | Installation/build lifecycle can execute dependency code before application runtime. | [npm scripts, CLI v11](https://docs.npmjs.com/cli/v11/using-npm/scripts/), “Life Cycle Scripts” and “Life Cycle Operation Order” | Runtime import reachability is not the only execution path. Verify the actual package manager version, command, scripts and restrictions. A lockfile entry alone does not prove execution. |
| SUPPLY-3 | Source/build identity and artifact promotion must refer to the intended production chain. | [SLSA v1.2 threats](https://slsa.dev/spec/v1.2/threats-overview), “Threat model” and integrity scope | Artifact production/promotion authority remains owned by CI references. Provenance presence is not proof that a consumer verified identity and policy. SLSA does not address every usage or malicious-producer threat. |
| SUPPLY-4 | Missing pinning, SBOM or attestation alone does not establish a repository exploit. | Project evidence policy; SLSA supplies threat context, not this reporting threshold | Require a concrete attacker-influenced selection/execution/promotion path. Dependency CVE presence and ordinary runtime reachability remain triage questions, not the center of this candidate. |

Potential increment: resolution and install/build execution before runtime. First probe pair: an attacker-publishable competing source actually selectable by the resolver versus an enforced trusted source. Downloaded-tool integrity and update rollback/freeze protection require additional source work before inclusion. Behavior evidence: not yet collected.

## Admission and maintenance decisions

A source-backed group is eligible for a narrow prototype, not automatically eligible for bundling. Before bundling, review a positive case, a counterexample and an unresolved-boundary case drawn independently from these mechanisms. Observe actual reads and answers using the deployed model. Do not require the no-skill baseline to fail. If both versions already reason correctly, reduce the candidate to its useful non-obvious groups or defer it.

Minimum record per experiment: model/configuration, candidate and reference hashes, independent fixture provenance, oracle and explicit unknowns, full outputs, actual read calls/results, and approximate context/tool cost. Forced-reading smoke tests, natural discovery tests and quality comparisons answer different questions. A few paired runs support local observations only; they do not establish a general quality improvement.
