---
name: web-security
description: "Use for web security at application and browser boundaries: authentication, authorization, sessions, request forgery, browser execution, server-side requests, database queries, uploads, and sensitive data exposed through web surfaces."
---

# Web Security Reference Skill

Use this skill as a compact reference pack for web application security review. It helps identify source/sink shapes, relevant guards, report conditions, and common false positives.

Do not use this skill as a general web security checklist or as proof that a vulnerability exists. The analyzer must still establish attacker influence, sink reachability, control coverage, control limits, and concrete security impact from repository evidence.

## Route

Read only the reference that matches the current reviewed lead:

- Authorization checks, tenant boundaries, object ownership, role checks, IDOR/BOLA, privilege escalation: read `/skills/web-security/references/access-control.md`.
- Login, session, JWT, OAuth/OIDC, password reset, cookie/session-token handling: read `/skills/web-security/references/auth-session.md`.
- Server-side URL fetches, webhooks, image/proxy fetchers, metadata/internal network access: read `/skills/web-security/references/ssrf.md`.
- SQL query construction, raw ORM fragments, dynamic filters/sorting, stored data later used in queries: read `/skills/web-security/references/sql-injection.md`.
- Cookie-authenticated state-changing requests, missing origin/token checks, browser-submittable privileged actions: read `/skills/web-security/references/csrf.md`.
- Upload endpoints, user-controlled filenames/content types, public serving of uploaded files, parser handoff: read `/skills/web-security/references/file-upload.md`.
- Credentials, tokens, private data, or diagnostic details exposed in HTTP responses, browser bundles, source maps, tenant-visible logs, or web debug endpoints: read `/skills/web-security/references/sensitive-data-exposure.md`.
- Raw HTML, DOM insertion, framework escape hatches, script execution, template output: read `/skills/web-security/references/xss.md`.

If the current lead is only broad hardening, missing policy, missing rate limiting, or checklist posture, do not load more references. Keep the concern non-confirmed unless repository evidence shows a concrete attacker-influenced path to a security-relevant effect.

## Use Rules

- Use references to choose what to inspect, not to conclude.
- Prefer the narrowest reference. Do not read the full skill directory.
- Treat examples as structural patterns. Framework and library behavior must still be verified from repository code and checked dependencies when material.
- When a reference lists a false-positive precedent, use it to lower or reject unsupported findings, not to ignore repository-specific dangerous sinks.
