# Cryptography Security Source Notes

Reviewed 2026-10-16. Requirements are tied to the actual primitive or protocol; they do not support a universal IV rule, algorithm blacklist, rotation schedule or complete PKI guide.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| CRYPTO-1: GCM invocation scope; `key-nonce-scope.md` | [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final), §§8 and 8.1, Appendix A | Assess IV uniqueness within a key's scope. Equal IV bytes under different established keys are not reuse for this rule. |
| CRYPTO-2: uniqueness versus randomness; `key-nonce-scope.md` | Same NIST source, §8.2 | A deterministic construction can satisfy uniqueness when persistence, concurrency and wrap are controlled. Do not require randomness when uniqueness is the contract. |
| CRYPTO-3: verification binding; `verification-contracts.md` | [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), §§3.1-3.4 | Bind algorithms, keys and required verification; do not act on authenticated results after failure. Limited parsing needed to verify is not automatically unsafe. |
| CRYPTO-4: token context; `verification-contracts.md` | RFC 8725, §§3.8-3.12 | Cryptographic validity is separate from issuer, audience, token type and application authorization. |
| CRYPTO-5: password verifiers; `password-verifiers.md` | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), §3.1.1.2 | Stored password verifiers need salt and a suitable password hashing scheme with cost. Fixed evergreen work factors are intentionally omitted. |

Public-data checksums are not password verifiers; signature validity alone is not identity; missing rotation alone is not a confirmed exploit.

## Coverage and deferred work

Current coverage: GCM nonce/key scope, verification and token-purpose contracts, and password verifiers. Deferred: full certificate-path processing, TLS configuration matrices, key-management operations, rotation programs, hardware security modules and evergreen algorithm recommendation tables. Those topics change faster or require operational context beyond repository code.
