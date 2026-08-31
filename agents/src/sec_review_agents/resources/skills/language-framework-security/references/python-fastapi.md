# FastAPI Security Semantics

Use this reference when a FastAPI lead depends on routing, dependencies, Pydantic validation, auth, cookies, templates, static files, uploads, background tasks, or framework configuration.

## Entry Points

- `main.py`, app factory modules, `APIRouter` declarations, dependency modules, middleware setup, auth helpers, settings files, `pyproject.toml`, `requirements*.txt`, `Dockerfile`, templates, static-file mounts, and tests.
- Follow the actual route registration path. A dependency or middleware only protects routes that are registered under it.

## Routing, Dependencies, And Auth

- `Depends(...)` can enforce authentication or authorization, but only if the dependency is attached to the specific route, router, or app path under review.
- Pydantic request models validate structure and types. They do not prove authorization, object ownership, tenant isolation, or business-rule checks.
- Response models can limit fields returned to clients. Verify the route actually uses the response model and does not return a raw response that bypasses it.
- Security dependencies such as OAuth2 or API key helpers often parse credentials. They are not authorization controls unless repository code checks the relevant user, role, tenant, object, or scope.

## Cookies, CORS, And CSRF

- CORS is a browser access policy, not an authorization control.
- If a state-changing route relies on cookie authentication, check CSRF defenses such as same-site cookie settings, origin or referer checks, or a verified CSRF token.
- If a route uses bearer tokens from an `Authorization` header and is not browser-submittable with ambient credentials, CSRF may not be the relevant threat. Confirm the credential flow from repository code.

## Templates And HTML

- Jinja2 can autoescape when configured for HTML templates. Confirm the template environment, file extension behavior, and rendering path.
- `TemplateResponse` with ordinary variables is not automatically XSS.
- `|safe`, `Markup`, disabled autoescape, `from_string` with user-controlled template text, or raw HTML responses are escape hatches. Trace attacker data to the rendered context before confirming XSS.

## Files, Static Assets, And Uploads

- `StaticFiles`, `FileResponse`, `StreamingResponse`, upload handlers, archive extraction, and generated filenames are common filesystem sinks.
- Check whether user-controlled paths are normalized against an allowed base directory and whether symlinks or sibling-prefix paths can cross the boundary.
- Uploads need explicit decisions about size, extension/content-type trust, parser handoff, storage path, public serving, overwrite behavior, and cleanup. Missing every upload hardening measure is not by itself a confirmed finding; confirm the dangerous path.

## Background Tasks And Server-Side Calls

- `BackgroundTasks` run server-side after the response path schedules them. Treat attacker influence over queued commands, URLs, file paths, recipients, or payloads as a normal source-to-sink question.
- For SSRF, check whether request input controls URL scheme, host, port, path, redirects, DNS, proxy behavior, or cloud metadata access.

## Dangerous Python Sinks

- `subprocess` with `shell=True` or shell strings is a command-injection candidate. With `shell=False`, inspect executable names, arguments, environment, working directory, and files consumed by the process.
- `pickle`, unsafe YAML loading, dynamic imports, `eval`, `exec`, and template compilation from user input are dangerous only when reachable from attacker influence under the reviewed boundary.

## Common False Positives

- A Pydantic model is not proof of authorization, but it may be valid input-shape validation.
- CORS misconfiguration is not the same as missing auth.
- Debug docs, OpenAPI exposure, reload mode, or permissive CORS are usually hardening concerns unless repository evidence shows sensitive exposure or a reachable exploit path.
