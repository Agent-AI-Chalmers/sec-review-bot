# Authentication And Session Reference

Use this reference for authentication bypass, session fixation, token validation mistakes, JWT/OAuth/OIDC implementation errors, password reset flows, and cookie/session handling.

## Sources

- Login, registration, password reset, magic link, invitation, SSO callback, OAuth/OIDC callback, MFA, refresh-token, logout, and session renewal endpoints.
- Cookies, bearer tokens, API keys, JWTs, authorization codes, refresh tokens, reset tokens, CSRF tokens, and remember-me tokens.
- User-controlled callback URLs, redirect URIs, `state`, `nonce`, `aud`, `iss`, `kid`, `alg`, role/tenant claims, and email/identity claims.
- Headers that influence authentication context, such as forwarded user headers, proxy identity headers, or custom internal auth headers.

## Sinks

- Session creation, account linking, login-as, impersonation, password/token reset, role assignment during registration, and trusted identity mapping.
- JWT verification, OAuth/OIDC token exchange, userinfo lookup, callback processing, token refresh, and session cookie issuance.
- Password hashing and comparison, MFA verification, reset-token validation, and session invalidation.

## Guards

- Validate issuer, audience, signature, expiration, not-before, nonce/state, redirect URI, and token type where relevant.
- Bind password reset, magic link, invitation, and OAuth state to the intended user/session and expire single-use tokens.
- Do not trust user identity, role, tenant, or email claims unless they come from a verified token or trusted server-side lookup.
- Set session cookies with appropriate `HttpOnly`, `Secure`, and `SameSite` attributes when browser cookie sessions protect sensitive actions.
- Invalidate or rotate sessions/tokens after privilege changes, password reset, and sensitive account recovery.

## Report Conditions

Report only when repository evidence shows:

- an attacker can influence authentication/session input;
- the code accepts or transforms that input into an authenticated identity/session/privilege;
- required verification or binding is missing, bypassed, or checked against the wrong value;
- impact is account takeover, authentication bypass, session theft/fixation, privilege escalation, or cross-account linking.

## False-Positive Precedents

- Missing cookie attributes alone may be hardening unless the session is sensitive and the threat model makes theft or cross-site use reachable.
- Client-side login-state checks are not an authentication boundary.
- JWT library usage is not suspicious by itself; inspect the actual verification options and claims consumed.
- A password reset endpoint is not vulnerable solely because it exists; require token predictability, leakage, reuse, missing binding, or unsafe state transition.
- Missing MFA is usually product hardening unless the code claims MFA enforcement and can be bypassed.
