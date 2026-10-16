# Signature Representation And Canonicalization

- Identify the exact bytes signed and the representation later authorized. Parsing and reserializing before or after verification can create a meaning gap even when the signature primitive is sound.
- Use the canonicalization or encoding defined by the protocol. JSON, ASN.1/DER, COSE and raw signature formats are not interchangeable.
- Signature malleability is scheme and verifier specific. For EdDSA, scalar-range checks are part of the documented verification contract; do not generalize this rule to every signature scheme.
- Multiple valid signatures for one message matter only when an application assumes signature bytes are a unique identifier, deduplication key or authorization token.

Report the exact representation disagreement or missing scheme-required validation and its security effect. Do not require canonical JSON or “low-S” signatures unless the actual protocol specifies that contract.
