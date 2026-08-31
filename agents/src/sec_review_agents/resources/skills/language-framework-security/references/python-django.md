# Django Security Semantics

Use this reference when a Django lead depends on views, middleware, URL routing, templates, forms, ORM access, file serving, auth, or settings.

## Entry Points

- `urls.py`, views, class-based views, serializers, forms, middleware, settings, templates, model managers, storage backends, and tests around the reported path.
- Follow the actual URL route and middleware order. A middleware or decorator only protects views it actually reaches.

## Auth, Authorization, And ORM

- `@login_required` proves authentication, not object ownership or role authorization.
- Querysets filtered by user, tenant, organization, or ownership can be real controls. Verify the filtered queryset is the one used by the sink.
- Django ORM parameterizes normal filters. Raw SQL, `.extra()`, `RawSQL`, dynamic table or column names, and string-built clauses need separate inspection.

## Templates And HTML

- Django templates autoescape ordinary variables by default for HTML contexts.
- `safe`, `mark_safe`, disabled autoescape, custom filters marked safe, or raw HTML responses are escape hatches. Trace attacker-controlled data to the final browser context before confirming XSS.

## CSRF And Cookies

- Django has CSRF middleware, but exemptions and API routes matter. Check `csrf_exempt`, custom middleware order, and whether state-changing routes use cookie authentication.
- CORS settings are not authorization controls.

## Files And Static Serving

- `FileResponse`, storage backends, uploaded filenames, archive extraction, and user-controlled download paths are filesystem sinks.
- `static` and `media` serving behavior depends on deployment. Confirm whether a user-controlled file can become publicly served or executed by another layer.

## Settings

- `DEBUG=True`, permissive `ALLOWED_HOSTS`, weak cookie flags, or broad CORS are usually hardening concerns unless repository evidence shows sensitive exposure or a reachable exploit path.
