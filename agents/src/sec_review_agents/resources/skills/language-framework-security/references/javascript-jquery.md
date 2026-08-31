# jQuery Security Semantics

Use this reference when legacy jQuery code depends on DOM insertion, selectors, AJAX flows, event handlers, plugins, or client-side routing.

## Entry Points

- `$(...)` construction, `.html()`, `.append()`, `.prepend()`, `.before()`, `.after()`, AJAX callbacks, plugin initialization, route/hash handlers, and server-rendered data injected into scripts.

## DOM XSS

- jQuery methods that parse HTML can execute attacker-controlled markup depending on browser and version behavior. Trace data into `.html()`, `$("<...>")`, `.append()`, or plugin APIs that accept HTML.
- `.text()` is usually a text sink and can be an escaping control.
- Selector injection is not automatically XSS. Confirm whether the selected value is interpreted as HTML, causes sensitive DOM access, or changes privileged behavior.

## AJAX And Client Trust

- AJAX code often reveals intended API shape, but server-side authorization still has to be verified on the server.
- Client-side filtering of object IDs, roles, or tenant IDs is not a server control.

## Common False Positives

- A jQuery version alone is not a confirmed repository finding unless the code reaches the vulnerable API pattern under attacker influence.
