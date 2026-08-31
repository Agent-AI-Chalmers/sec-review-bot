# CSRF Reference

Use this reference for browser-submittable state-changing requests that rely on ambient credentials such as cookies, Basic authentication, or client certificates.

## Sources

- Attacker-controlled web pages that can cause the victim browser to submit forms, navigate URLs, load images/scripts, or trigger simple cross-origin requests.
- State-changing endpoints using cookie sessions, Basic auth, implicit browser credentials, or same-site credentials.
- HTTP methods and content types that browsers can send cross-site without custom headers.

## Sinks

- Password/email change, account linking, billing, transfer, invite, role/permission change, settings update, delete, publish, checkout, admin action, webhook change, API key creation, and logout/login state transitions.
- Endpoints that accept GET for state changes or accept form-encoded POST without an origin/token check.
- OAuth/OIDC flows where missing or weak `state` binding permits login CSRF or account-linking attacks.

## Guards

- Use unpredictable CSRF tokens bound to the session or request context and verify them server-side.
- Check `Origin` or `Referer` as a defense-in-depth control, with careful handling of absent headers.
- Use `SameSite` cookies where appropriate, but do not treat them as the only control for high-risk actions without validating browser and flow constraints.
- Require non-simple content types/custom headers only when CORS and preflight behavior are correctly enforced.
- Reauthenticate or require step-up confirmation for especially sensitive actions.

## Report Conditions

Report only when repository evidence shows:

- a browser can cause the request cross-site;
- the request performs a privileged state-changing action;
- the application relies on ambient credentials;
- server-side CSRF/origin/state validation is missing, bypassed, or not applied to the endpoint.

## False-Positive Precedents

- Read-only endpoints are not CSRF findings unless they trigger side effects or leak through a browser-readable channel.
- Bearer-token APIs that require a non-cookie `Authorization` header are usually not CSRF unless the token is automatically attached or CORS enables attacker control.
- Missing CSRF token in a JSON API is not enough if the request requires custom headers and CORS blocks attacker-origin submission.
- `SameSite` may be a relevant guard; do not ignore it, but verify the cookie mode and request context.
- Client-side CSRF token generation is not a guard unless the server validates an unpredictable token tied to trusted state.
