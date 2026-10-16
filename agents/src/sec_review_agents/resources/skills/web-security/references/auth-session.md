# Authentication And Session Reference

Use this reference for authentication bypass, session fixation, token validation mistakes, JWT/OAuth/OIDC implementation errors, password reset flows, credential protection, authentication availability, and cookie/session lifecycle handling.

## Sources

- Login, registration, password reset, magic link, invitation, SSO callback, OAuth/OIDC callback, MFA, refresh-token, logout, and session renewal endpoints.
- Cookies, bearer tokens, API keys, JWTs, authorization codes, refresh tokens, reset tokens, CSRF tokens, and remember-me tokens.
- User-controlled callback URLs, redirect URIs, `state`, `nonce`, `aud`, `iss`, `kid`, `alg`, role/tenant claims, and email/identity claims.
- Headers that influence authentication context, such as forwarded user headers, proxy identity headers, or custom internal auth headers.

## Sinks

- Session creation, account linking, login-as, impersonation, password/token reset, role assignment during registration, and trusted identity mapping.
- JWT verification, OAuth/OIDC token exchange, userinfo lookup, callback processing, token refresh, and session cookie issuance.
- Password storage, hashing and comparison, MFA verification, reset-token validation, session invalidation, and account lockout or login-attempt handling.

## Guards

- Validate issuer, audience, signature, expiration, not-before, nonce/state, redirect URI, and token type where relevant.
- Bind password reset, magic link, invitation, and OAuth state to the intended user/session and expire single-use tokens.
- Do not trust user identity, role, tenant, or email claims unless they come from a verified token or trusted server-side lookup.
- Set session cookies with appropriate `HttpOnly`, `Secure`, and `SameSite` attributes when browser cookie sessions protect sensitive actions.
- Check the session/token lifecycle required by the application: renewal after authentication or privilege changes, expiry, logout, recovery, and revocation. Verify which sessions and tokens an event actually invalidates; do not assume that terminating an identity-provider session terminates every relying-party session.
- For stored passwords, inspect the password hashing scheme, salt, and work factor in the relevant implementation. Distinguish an offline credential-compromise threat from online login guessing.
- Inspect whether login throttling or lockout can be bypassed or attacker-triggered against another account; absence of a named rate-limit mechanism alone is not proof.

## Report Conditions

Establish the affected authentication asset or operation, the failing control, the relevant attacker capability, and the resulting security effect. The evidence shape depends on the failure:

- Identity or account-binding failure: attacker-influenced input is accepted as an unauthorized identity, account link, or privilege because verification or binding is missing, bypassed, or applied to the wrong value.
- Session lifecycle failure: a token or session remains usable beyond the boundary it is meant to enforce, such as logout, expiry, revocation, or an account/privilege transition. Establish the application's intended boundary and the attacker's ability to use the surviving credential.
- Credential protection failure: actual password/credential handling enables disclosure or materially weakens resistance to compromise. State assumptions such as an attacker obtaining the stored verifier; do not invent a repository leak or require this defect to create a new authenticated session itself.
- Authentication availability or guessing failure: attacker-triggerable behavior enables a concrete account lockout or credible guessing path. Explain the attempt scope, limits, recovery, and attacker effort rather than reporting a missing mechanism by name.

A mismatch with a standard's assurance level or preferred configuration alone is not a confirmed repository vulnerability.

## False-Positive Precedents

- Missing cookie attributes alone may be hardening unless the session is sensitive and the threat model makes theft or cross-site use reachable.
- Client-side login-state checks are not an authentication boundary.
- JWT library usage is not suspicious by itself; inspect the actual verification options and claims consumed.
- A password reset endpoint is not vulnerable solely because it exists; require token predictability, leakage, reuse, missing binding, or unsafe state transition.
- Missing MFA is usually product hardening unless the code claims MFA enforcement and can be bypassed.
