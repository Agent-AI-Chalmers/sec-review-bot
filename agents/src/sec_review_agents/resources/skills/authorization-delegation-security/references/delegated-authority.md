# Delegation, Impersonation And Confused Deputies

- Distinguish the subject whose resources are affected from the actor performing the operation. Delegation preserves an acting identity; impersonation may intentionally make the actor indistinguishable within a defined rights context.
- Bind delegated credentials to intended audience, scope, target resource, actor and lifetime. Do not forward a broadly reusable upstream credential when a narrower downstream credential is required.
- A confused deputy exists when a less-authorized requester can cause an intermediary to exercise authority the requester could not exercise directly and the intermediary fails to enforce the intended request policy.
- Proxying and on-behalf-of behavior are often legitimate. Require a disallowed operation or target, not merely different service privileges.

Report the requester, deputy, target, delegated credential or operation, missing binding/check and concrete unauthorized effect.
