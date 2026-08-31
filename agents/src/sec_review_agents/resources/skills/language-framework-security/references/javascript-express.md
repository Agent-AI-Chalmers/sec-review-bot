# Express Security Semantics

Use this reference when an Express lead depends on routes, middleware order, request parsing, auth, cookies, templates, static files, uploads, or server-side fetch/process/file sinks.

## Entry Points

- `app.use`, router registration, route handlers, middleware, auth helpers, template setup, static file mounts, upload handlers, config, and tests.
- Middleware order is decisive. A middleware protects only later matching routes.

## Request Data And Validation

- `req.params`, `req.query`, `req.body`, headers, cookies, and uploaded files are attacker-controlled unless a verified parser or validator has already produced the value used by the sink.
- TypeScript types or JSDoc annotations are not runtime validation.

## Auth, Cookies, And CSRF

- Authentication middleware is not object ownership or role authorization.
- Cookie-authenticated state-changing routes may need CSRF defenses. Header bearer token APIs may have a different threat model; confirm the credential flow.
- CORS is not an authorization control.

## Templates And HTML

- Template escaping depends on the engine and the output syntax. Verify the configured engine and any raw-output syntax such as triple braces or unescaped render helpers.
- Raw HTML responses, Markdown rendering, or manual string concatenation are XSS sinks only when attacker data reaches browser-executed context.

## Files, Static Assets, And Uploads

- `express.static`, `res.sendFile`, download routes, upload filenames, archive extraction, and generated paths are filesystem sinks.
- Check base-directory containment after normalization and symlink behavior when path traversal matters.
- Upload handling needs repository evidence about size, type trust, parser handoff, storage path, public serving, and overwrite behavior.

## Server-Side Calls

- `child_process.exec` and shell strings are shell-injection candidates. `spawn`/`execFile` with fixed binaries require argument-semantics review.
- Server-side `fetch`, `axios`, proxy routes, webhooks, and import-by-URL flows can be SSRF sinks when attacker input controls the final request target.
