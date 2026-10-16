---
name: authorization-delegation-security
description: "Use for non-browser service or workload identity, protocol- or credential-level delegated and impersonated authority, on-behalf-of calls, trust domains, and confused-deputy behavior. OS thread/token impersonation remains in os-boundary-security; Web request/object authorization remains in web-security."
---

# Authorization And Delegation Security

- For workload/service identity, trust domains, identity documents and peer-policy binding: read `/skills/authorization-delegation-security/references/service-workload-identity.md`.
- For protocol- or credential-level delegation and impersonation, actor/subject distinction, on-behalf-of calls and confused deputies: read `/skills/authorization-delegation-security/references/delegated-authority.md`.

Trace the original subject, acting service, target resource, credential audience/scope and authority actually exercised. Authentication of a service or token does not by itself authorize the requested delegated action.
