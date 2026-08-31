# Go Backend Security Semantics

Use this reference for Go repository code when the current lead depends on how Go handles commands, templates, HTTP servers or clients, paths, files, archives, randomness, or password storage.

## Entry Points

- `go.mod`, `go.sum`, framework setup, `main.go`, `cmd/**`, `internal/**`, route registration, middleware, generated handlers, and tests around the reported behavior.
- HTTP handlers, RPC handlers, CLI command handlers, webhook processors, file upload/download handlers, archive importers, template rendering code, and outbound request wrappers.

## Process Execution

- `exec.Command(name, args...)` does not invoke a shell by itself. Treat argument injection differently from shell command injection.
- `exec.Command("sh", "-c", value)`, `exec.Command("bash", "-c", value)`, or string-built commands passed through a shell are shell-injection candidates when attacker-controlled data reaches the command string.
- For non-shell execution, inspect whether attacker input controls the executable name, option flags, file paths, environment variables, working directory, or files later consumed by the process.
- A fixed executable plus attacker-controlled arguments is not automatically a vulnerability. Confirm whether those arguments can change operation, read or write unintended files, reach network resources, or cross a privilege boundary.

## Templates And HTML Output

- `html/template` contextually escapes normal data for HTML output. Its use is a meaningful control, but only for data rendered through that engine and context.
- `text/template` is not an HTML escaping control.
- `template.HTML`, `template.JS`, `template.CSS`, `template.URL`, or custom trusted wrapper types can bypass escaping. Check whether attacker-controlled data can enter those types.
- Do not report XSS from a template variable only because the value is user controlled. Verify the template package, output context, and any escape hatch.

## HTTP Servers

- A zero-value `http.Server` has no read, write, or header timeouts. That can be security-relevant for public servers, but it is usually a hardening concern unless repository evidence shows a reachable denial-of-service boundary.
- Request body size is not automatically bounded. Look for `MaxBytesReader`, explicit `io.LimitReader`, framework limits, reverse-proxy limits, or parser limits when upload size matters.
- Middleware order matters. An auth, CSRF, body-limit, or recovery middleware only covers routes that are actually registered behind it.

## Outbound HTTP And SSRF

- `http.Get`, `http.Post`, and a default `http.Client` have no request timeout. Missing timeout alone is usually hardening unless it creates a reachable denial-of-service or resource exhaustion path.
- For SSRF, confirm attacker influence over scheme, host, port, path, redirects, DNS resolution, or proxy behavior. A URL allowlist must cover the component the sink actually uses.
- Closing `resp.Body` matters for resource leaks. Treat it as security-relevant only when the reachable behavior can exhaust resources or affect isolation.

## Paths, Files, And Archives

- `filepath.Join(base, userPath)` does not by itself prove the result stays under `base`. Check cleaning, absolute path handling, symlinks, and final boundary checks when traversal matters.
- A robust base-directory check usually compares normalized absolute paths and handles path separators so sibling prefixes do not pass.
- `http.ServeFile`, `FileServer`, `os.Open`, `os.WriteFile`, `os.Create`, archive extraction, and generated filenames are common sinks.
- Archive extraction needs separate checks for entry names, absolute paths, `..`, symlinks, hardlinks, permissions, and overwrite behavior.

## Randomness And Passwords

- `crypto/rand` is the usual source for secrets, tokens, and keys. `math/rand` is predictable unless the repository proves the value is non-security-sensitive.
- Password storage should use a password hashing algorithm such as bcrypt, scrypt, or Argon2. Fast hashes such as SHA-256 are not password storage controls by themselves.

## Common False Positives

- `html/template` with ordinary values is often an XSS control, not a sink.
- `exec.Command` with a fixed binary and separate fixed arguments is not shell injection unless the dangerous effect comes from argument semantics.
- Missing timeouts, security headers, or body limits are usually not confirmed findings without a reachable boundary and concrete security effect.
