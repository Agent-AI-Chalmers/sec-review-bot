---
name: cryptography-security
description: "Use for cryptographic primitive contracts, key and nonce scope, randomness requirements, verification failure, authenticated-result consumption, and password verifier storage. It is not a general PKI or algorithm checklist."
---

# Cryptography Security

- For nonce/IV requirements, key scope, counters and randomness properties: read `/skills/cryptography-security/references/key-nonce-scope.md`.
- For signature/MAC verification, algorithm binding, failure behavior, token purpose and password verifiers: read `/skills/cryptography-security/references/verification-contracts.md`.
- For stored password verifiers and offline guessing resistance: read `/skills/cryptography-security/references/password-verifiers.md`.
- For deriving distinct cryptographic keys from shared key material and binding derivation to purpose or tenant context: read `/skills/cryptography-security/references/key-derivation.md`.
- For signed-byte representation, canonicalization and scheme-specific signature malleability: read `/skills/cryptography-security/references/signature-representation.md`.

Verify the actual primitive or protocol and its version. Do not generalize one mode's requirements to all cryptography, and do not treat cryptographic validity as proof of application authorization.
