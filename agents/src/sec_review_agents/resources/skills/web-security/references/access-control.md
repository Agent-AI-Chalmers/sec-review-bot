# Access Control Reference

Use this reference for authorization, object ownership, tenant isolation, IDOR/BOLA, vertical privilege escalation, horizontal privilege escalation, and state-dependent access control.

## Sources

- Route, query, body, path, GraphQL variable, or RPC parameter that names an object, tenant, account, organization, project, user, order, invoice, file, or admin action.
- Session user, API key principal, service account, impersonation context, role/permission claims, and tenant/account selection.
- Client-supplied role, plan, account, organization, owner, admin, or feature flag values.
- Multi-step flows where earlier steps select a privileged target later used without rechecking authorization.
- Static files, exports, reports, or object storage keys derived from user-controlled IDs.

## Sinks

- Read, update, delete, transfer, approve, invite, export, download, billing, admin, moderation, or role-management actions.
- Database queries or storage lookups where attacker-controlled object IDs are used before ownership or permission checks.
- Middleware, decorators, guards, policy engines, resolver-level checks, row-level security, and tenant scoping helpers.
- Background jobs or webhooks that later execute with a stored user-selected target.
- Direct object storage reads/writes, signed URL creation, report downloads, and file export endpoints.

## Guards

- Server-side authorization must be enforced at the action/resource boundary, not only in UI routing or hidden buttons.
- Object ownership and tenant membership should be checked on the resolved resource, not only on a supplied parent ID.
- Role and permission claims should come from trusted server-side state or validated tokens, not mutable request fields.
- Admin and cross-tenant actions should require explicit policy checks close to the sensitive operation.
- Multi-step workflows should revalidate the current actor, target, and state at the final state-changing step.

## Report Conditions

Report only when repository evidence shows:

- an attacker-controlled principal or object identifier;
- a reachable server-side path to sensitive data or privileged action;
- missing, bypassed, or incorrectly scoped authorization on that resolved resource/action;
- concrete impact, such as cross-user data access, cross-tenant access, role escalation, unauthorized mutation, or privileged operation.

## False-Positive Precedents

- Client-side routing, button hiding, or UI-only admin checks are not a trusted boundary by themselves.
- A missing frontend check is not a vulnerability if the server endpoint enforces the action correctly.
- A generic role or permission name in code is not evidence of broken access control without a reachable unauthorized path.
- Returning `403`, `404`, or redirect can still be safe if no sensitive data or action occurs before the denial.
- A broad "should centralize authorization" hardening suggestion is not a confirmed finding without a concrete bypass.
