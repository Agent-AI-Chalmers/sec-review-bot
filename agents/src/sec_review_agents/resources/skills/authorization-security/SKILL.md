---
name: authorization-security
description: "Use for application and service authorization: object ownership, tenant and role boundaries, workload identity, delegated or impersonated authority, on-behalf-of calls, trust domains, and confused deputies. Browser session and request-forgery mechanics remain in web-security; OS token impersonation remains in os-boundary-security."
---

# Authorization Security

- For object ownership, tenant isolation, role checks, resource/action authorization and IDOR/BOLA across HTTP, RPC, queues, jobs or service APIs: read `/skills/authorization-security/references/access-control.md`.
- For workload/service identity, trust domains, identity documents and peer-policy binding: read `/skills/authorization-security/references/service-workload-identity.md`.
- For protocol- or credential-level delegation and impersonation, actor/subject distinction, on-behalf-of calls and confused deputies: read `/skills/authorization-security/references/delegated-authority.md`.

Trace the requester or original subject, acting service, resolved target resource, requested action, credential audience/scope and authority actually exercised. Authentication of a user, service or token does not by itself authorize the target action.
