---
name: language-framework-security
description: "Use as a reference for language and framework security semantics such as Express route/middleware order, Django ORM/query generation, template escaping, validation, file serving, static assets, server/client boundaries, or process execution."
---

# Language and Framework Security Reference Skill

Use this skill when repository code depends on language or framework behavior: process execution, template escaping, route handling, validation, file serving, static assets, server/client boundaries, or framework middleware.

Do not use this skill as a general best-practices checklist. It is not a mandate to scan every framework feature, audit every dependency, or report hardening gaps. The reviewed repository still has to provide the concrete source, sink, control coverage, control limits, and security impact.

## Route

Read only the reference that matches the current repository code under review:

- Go backend code using `net/http`, templates, filesystem access, subprocesses, outbound HTTP, archive handling, random values, or password hashing: read `/skills/language-framework-security/references/go-backend.md`.
- FastAPI code using routers, dependencies, Pydantic models, templates, static files, uploads, CORS, cookies, or background tasks: read `/skills/language-framework-security/references/python-fastapi.md`.
- Django code using URL routes, views, middleware, templates, forms, ORM access, file serving, auth, or settings: read `/skills/language-framework-security/references/python-django.md`.
- Flask code using route decorators, blueprints, request parsing, templates, sessions, file serving, extensions, or app configuration: read `/skills/language-framework-security/references/python-flask.md`.
- Express code using route handlers, middleware order, request parsing, auth, cookies, templates, static files, uploads, or server-side calls: read `/skills/language-framework-security/references/javascript-express.md`.
- Next.js code using App Router route handlers, Pages API routes, Server Actions, middleware/proxy matchers, cookies, environment variables, fetches, caching, or unsafe HTML output: read `/skills/language-framework-security/references/javascript-typescript-nextjs.md`.
- React code using component rendering, props/state, raw HTML, client-side guards, storage, or API calls: read `/skills/language-framework-security/references/javascript-typescript-react.md`.
- Vue code using templates, directives, router guards, stores, raw HTML, SSR, or client-side API calls: read `/skills/language-framework-security/references/javascript-typescript-vue.md`.
- jQuery code using DOM insertion, selectors, AJAX flows, event handlers, plugins, or hash routing: read `/skills/language-framework-security/references/javascript-jquery.md`.
- Framework-neutral browser code using DOM sinks, client-side routing, storage, `postMessage`, redirects, or client-only trust decisions: read `/skills/language-framework-security/references/javascript-frontend.md`.

If the current lead is only broad hardening, dependency posture, or a generic "this framework can be dangerous" concern, do not load more references. Keep it non-confirmed unless repository evidence shows a concrete dangerous path.

## Use Rules

- Use language facts to decide what code to inspect, not to conclude.
- Prefer the narrowest reference. Do not read the full skill directory.
- Treat framework defaults as hypotheses until the repository's version, configuration, and call path make them material.
- Do not import vendor scan/report workflow from the source material. This skill is a project-owned reference pack, not a third-party reviewer persona.
