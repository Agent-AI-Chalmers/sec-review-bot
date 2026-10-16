# Service And Workload Identity

- Identify the workload identity, issuer or trust domain, credential type, verifier trust roots and the policy that maps identity to permissions.
- A valid certificate or token proves only the identity and claims it actually binds. Verify trust-domain, audience and intended workload before authorization.
- Separate process/service account identity from the human or upstream service that initiated a request. Shared service credentials can erase caller attribution.
- Short-lived credentials and rotation reduce exposure but do not replace peer authorization or trust-domain checks.

Report only a concrete identity confusion, unintended trust-domain acceptance or authorization granted to the wrong workload. Missing a preferred identity platform alone is not a finding.
