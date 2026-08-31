---
name: web-security
description: "Use as a reference for web security source/sink analysis, guard evaluation, report conditions, and false-positive precedents across application security review, discovery, triage, validation, and verification."
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
- Shell/process execution, system utilities, archive/converter wrappers, user-controlled command strings or arguments: read `/skills/web-security/references/command-injection.md`.
- Cookie-authenticated state-changing requests, missing origin/token checks, browser-submittable privileged actions: read `/skills/web-security/references/csrf.md`.
- Upload endpoints, user-controlled filenames/content types, public serving of uploaded files, parser handoff: read `/skills/web-security/references/file-upload.md`.
- Secrets in responses, logs, client bundles, debug endpoints, repository/config artifacts: read `/skills/web-security/references/secrets-exposure.md`.
- Raw HTML, DOM insertion, framework escape hatches, script execution, template output: read `/skills/web-security/references/xss.md`.
- File paths, upload filenames, archive extraction, filesystem reads/writes, static file serving: read `/skills/web-security/references/path-traversal.md`.
- Serialized objects, YAML/XML parsing, uploaded imports, cookie/session blobs, message payloads: read `/skills/web-security/references/deserialization.md`.

If the current lead is only broad hardening, missing policy, missing rate limiting, or checklist posture, do not load more references. Keep the concern non-confirmed unless repository evidence shows a concrete attacker-influenced path to a security-relevant effect.

## Use Rules

- Use references to choose what to inspect, not to conclude.
- Prefer the narrowest reference. Do not read the full skill directory.
- Treat examples as structural patterns. Framework and library behavior must still be verified from repository code and checked dependencies when material.
- When a reference lists a false-positive precedent, use it to lower or reject unsupported findings, not to ignore repository-specific dangerous sinks.
