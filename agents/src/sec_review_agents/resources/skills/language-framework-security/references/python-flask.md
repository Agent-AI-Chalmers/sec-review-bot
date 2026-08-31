# Flask Security Semantics

Use this reference when a Flask lead depends on routes, decorators, request parsing, templates, sessions, file serving, extensions, or app configuration.

## Entry Points

- App factory, blueprint registration, route decorators, auth decorators, `before_request` hooks, error handlers, templates, config loading, extensions, and tests around the reported route.
- Follow the actual blueprint and decorator stack. A helper is a control only if the route under review calls it or is registered behind it.

## Auth And Sessions

- Flask does not provide authorization by default. `login_required`-style decorators prove authentication only when attached to the route.
- Signed cookies protect integrity if the secret key is strong and private. They do not make client-visible session data confidential.

## Templates And HTML

- Jinja2 autoescape usually applies to HTML templates loaded by extension. Verify the template environment and rendering path.
- `Markup`, `|safe`, disabled autoescape, `render_template_string` with attacker-controlled template text, and raw HTML responses are escape hatches.

## Files And Uploads

- `send_file`, `send_from_directory`, upload filenames, archive extraction, and generated paths are filesystem sinks.
- `secure_filename` helps normalize filenames but does not prove base-directory containment, extension safety, parser safety, public serving safety, or overwrite behavior by itself.

## Request Data And Server-Side Calls

- `request.args`, `request.form`, `request.json`, headers, cookies, and uploaded files are attacker-controlled at the route boundary.
- For SSRF or command execution, trace those values into URL fetches, shell commands, subprocess arguments, file paths, or parser handoff.

## Common False Positives

- Debug mode, missing headers, broad CORS, or weak cookie flags are usually not confirmed findings without a reachable sensitive boundary.
