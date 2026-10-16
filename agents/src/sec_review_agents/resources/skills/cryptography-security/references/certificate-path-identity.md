# Certificate Path And Service Identity

- A chain of valid signatures is not sufficient certificate-path validation. Establish the trust anchor, time, basic constraints, path length, key usage, extended key usage, name constraints and critical extensions required by the relying application.
- Match the presented TLS identity against the reference identity derived from trusted application configuration. SNI, connection destination, certificate subject text and successful path validation are not interchangeable identity checks.
- Revocation, transparency and pinning are policy- and deployment-specific. Report their absence only when the repository has an applicable enforcement contract or a concrete bypass path.
- Keep workload authorization in authorization/delegation security. This reference establishes certificate/path and peer-identity validity, not what an authenticated service may do.

Report the exact ignored constraint or identity mismatch and the unauthorized peer or capability it enables. Do not require a universal PKI policy.
