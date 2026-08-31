# Secrets Exposure Reference

Use this reference for credentials, tokens, private keys, session material, API keys, cloud credentials, internal URLs, debug dumps, and sensitive data exposed through web application surfaces.

## Sources

- Environment variables, config files, `.env`, CI variables, secrets managers, deployment manifests, logs, traces, error reports, debug endpoints, client bundles, source maps, repository files, and generated artifacts.
- Authentication tokens, API keys, OAuth client secrets, webhook secrets, signing keys, private keys, database URLs, cloud credentials, session cookies, reset tokens, and internal service credentials.
- User-triggered errors, exports, diagnostics, support bundles, health endpoints, metrics, and admin/debug features.

## Sinks

- HTTP responses, JSON APIs, GraphQL errors, logs visible to users/tenants, frontend bundles, source maps, downloadable artifacts, public object storage, cache entries, crash reports, analytics, and third-party monitoring.
- Repository commits, examples, fixtures, test snapshots, Docker images, build output, and CI logs.
- Error formatting that includes request headers, environment, stack traces, SQL connection strings, or full exception objects.

## Guards

- Keep secrets server-side and outside client bundles.
- Redact known secret patterns and sensitive headers before logging or returning errors.
- Restrict debug/diagnostic endpoints to trusted operators and safe environments.
- Use secret managers or environment injection with minimal exposure to build and runtime logs.
- Treat source maps and build artifacts as public if deployed to public web roots.
- Rotate exposed credentials when confirmed exposure exists.

## Report Conditions

Report only when repository evidence shows:

- a secret or sensitive security token can be exposed to an unauthorized user, tenant, public artifact, client bundle, or log reader;
- the exposed value is live, plausibly live, or security-relevant enough to enable follow-on compromise;
- access path and impacted secret class are concrete.

## False-Positive Precedents

- Placeholder values such as `example`, `changeme`, or documented dummy keys are not findings unless used as real defaults in production.
- A variable named `SECRET` is not exposure unless its value reaches an unauthorized sink.
- Logging generic errors is not a finding without sensitive content or unauthorized log access.
- Internal URLs alone are usually information disclosure/hardening unless they include credentials or materially aid an exploit path.
- Public source maps or bundled source are not confirmed secrets exposure unless they contain live or plausibly live secrets, security tokens, or sensitive configuration. If exposed source reveals a boundary bypass, prove it as a separate information-disclosure or exploit-chain issue.
- Client-side public API keys may be intentional for some providers; confirm whether the key is actually secret and what authorization it grants.
