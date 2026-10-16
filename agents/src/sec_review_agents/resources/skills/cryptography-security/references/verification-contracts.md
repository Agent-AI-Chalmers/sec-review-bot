# Verification And Authenticated Results

- Bind verification to allowed algorithms, the intended key, and every required cryptographic operation. Reject failures before acting on authenticated claims or data.
- Limited parsing needed to locate verification inputs is distinct from authorizing or executing unverified content.
- Signature validity does not establish issuer, audience, token type, session meaning or application authorization; inspect the consumer's policy.
Do not turn missing rotation, PKI operations or a preferred algorithm list into findings without a sourced repository-specific contract and exploit path.
