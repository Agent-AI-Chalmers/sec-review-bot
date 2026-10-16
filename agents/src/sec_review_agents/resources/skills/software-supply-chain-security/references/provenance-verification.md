# Provenance Verification And Consumption

- A generated or signed attestation has no enforcement effect until a consumer verifies it against policy.
- Bind the attestation subject digest to the artifact being admitted, verify the envelope/root of trust, and compare signer or builder identity, predicate type, parameters and materials with explicit expectations.
- A valid signature proves control of the signing identity, not that the builder, source, parameters or artifact are the ones policy intended.
- Keep provenance production authority in CI analysis; this reference covers the consumer's admission decision.

Missing provenance alone is not a vulnerability. Report when a claimed verification path accepts an attacker artifact because subject or identity/policy binding is absent or fail-open.
