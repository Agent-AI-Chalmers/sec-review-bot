# Next.js Security Semantics

Use this reference when a Next.js lead depends on App Router, Pages API routes, Server Actions, middleware or proxy matchers, server/client boundaries, cookies, environment variables, caching, fetch behavior, or unsafe HTML output.

## Entry Points

- `app/**/route.{js,ts}`, `pages/api/**`, Server Actions, server components, middleware or proxy files, `next.config.*`, auth helpers, data-fetching helpers, environment variable usage, generated route manifests, and tests.
- Follow the concrete route or action under review. A global-looking helper is a control only where the route actually calls it or is matched by it.

## Runtime Validation And Types

- TypeScript types are compile-time facts, not runtime validation for HTTP inputs, cookies, headers, query strings, form data, JSON bodies, or Server Action arguments.
- Zod, Valibot, custom validators, schema parsers, or framework-specific request parsing can be real controls. Verify the parsed value is the one used by the sink.

## Server And Client Boundary

- Code in client components and browser bundles cannot protect server-side secrets or authorization decisions.
- Variables prefixed with `NEXT_PUBLIC_` are intended for client exposure. Do not report them as leaked secrets solely because they appear in client code.
- Server-only environment variables, cookies, tokens, database clients, and filesystem access should stay on the server side. Confirm whether a value can cross into a client bundle, rendered HTML, API response, or log.

## Route Handlers, API Routes, And Server Actions

- Route handlers and Pages API routes need their own auth and authorization checks unless a verified wrapper or middleware covers them.
- Server Actions are network-callable server entry points. State-changing actions should validate caller identity, authorization, target object, and input shape server-side.
- Cookie-authenticated state-changing endpoints may need CSRF defenses depending on how the route can be submitted and how cookies are configured.

## Middleware And Proxy Matchers

- Middleware or proxy code protects only matched paths. Check matcher patterns, exclusions, rewrites, API routes, static assets, route groups, and deployment behavior before treating it as a global control.
- Middleware that checks authentication does not automatically prove object-level authorization inside the route.

## HTML Output And XSS

- React escapes ordinary rendered values. Do not confirm XSS from interpolation alone.
- `dangerouslySetInnerHTML`, raw Markdown or MDX rendering, custom HTML sanitizers, rich-text previews, route handlers returning `text/html`, and third-party widgets are escape hatches. Trace attacker-controlled data into the final browser-executed context.
- Sanitizer presence proves only the tags, attributes, protocols, and contexts it actually covers.

## Fetch, SSRF, And Redirects

- Server-side `fetch`, image proxy routes, webhook relay, import-by-URL, preview fetchers, and metadata fetchers can be SSRF sinks.
- Confirm attacker control over scheme, host, port, path, redirects, DNS, proxy behavior, or internal network reachability.
- A URL check that validates only the displayed string may not cover the final request after redirects or normalization.

## Caching And Static Rendering

- Static rendering, route caching, fetch caching, and incremental regeneration can expose data if a route mixes user-specific data with public cache scope.
- Treat caching as security-relevant only when repository evidence shows sensitive, tenant-specific, or authorization-dependent data can be cached and served across users.

## Common False Positives

- Type annotations alone are not a runtime control, but a real parser used before the sink may be.
- Missing CSP or security headers is usually hardening unless the reviewed lead already proves browser-executable content or sensitive exposure.
- Client-side checks are useful UX but not authorization. Confirm whether the server repeats the check before reporting or rejecting a finding.
