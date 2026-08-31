# SSRF Reference

Use this reference for server-side URL fetches, webhooks, link previews, image proxies, importers, callbacks, metadata access, internal network access, and URL parser/filter bypasses.

## Sources

- URL, hostname, scheme, path, redirect target, webhook endpoint, avatar/image URL, import URL, feed URL, callback URL, OpenGraph/link-preview URL, proxy target, or storage endpoint supplied by a user or tenant.
- URLs embedded in uploaded documents, XML/HTML/metadata, archive manifests, dependency manifests, or external API payloads.
- Stored URLs that are later fetched by a job, worker, crawler, scanner, or integration.
- Partially controlled URL components, such as host, path, query, scheme, or redirect target.

## Sinks

- HTTP clients, URL fetchers, webhook dispatchers, image downloaders, PDF/rendering services, XML parsers with remote entity access, browser automation, proxy endpoints, and cloud SDK calls built from user-controlled endpoints.
- Follow-redirect behavior, DNS resolution, connection establishment, response forwarding, file writes based on fetched content, and internal-service authentication reuse.
- Access to loopback, private RFC1918 networks, link-local addresses, cloud metadata endpoints, Kubernetes/internal service DNS, admin panels, and service discovery hosts.

## Guards

- Parse URLs with a standard parser, normalize before policy decisions, and enforce allowed schemes and hosts.
- Resolve DNS and validate the final connection target; protect against redirects, DNS rebinding, IPv6, numeric IP encodings, userinfo, fragments, mixed case, and parser discrepancies.
- Prefer an allowlist of exact trusted hosts or service IDs over blocklists of private ranges.
- Disable or revalidate redirects; validate each hop before connecting.
- Avoid forwarding secrets, cookies, internal headers, or privileged credentials to attacker-influenced hosts.
- Separate external fetchers from privileged internal networks where possible.

## Report Conditions

Report only when repository evidence shows:

- attacker influence over a server-side fetch target or redirect chain;
- a reachable fetch/connect sink;
- missing or bypassable validation of final destination;
- security impact such as internal network access, metadata credential access, sensitive response disclosure, privileged action, or onward request abuse.

## False-Positive Precedents

- Merely accepting a URL is not SSRF unless the server fetches or connects to it.
- A server-side fetch to an exact configured trusted host is not SSRF without attacker-controlled host/scheme/redirect influence.
- URL validation code is not automatically safe or unsafe; inspect whether the same parsed/normalized/final destination is used for both validation and connection.
- Blocking `localhost` alone is not a complete guard, but do not report unless there is an exploitable bypass path in the reviewed code.
- Client-side navigation to a user URL is not SSRF.
