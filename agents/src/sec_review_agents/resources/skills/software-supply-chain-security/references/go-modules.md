# Go Module Sources And Integrity

- Trace `GOPROXY` order, `direct` fallback, module path, selected version and any `replace` directive. Private-module settings change which proxy and checksum services are contacted.
- `go.sum` and the checksum database authenticate downloaded module content within their documented scope. Verify whether `GONOSUMDB`, `GOSUMDB=off`, private-module rules or replacements remove that check for the relevant module.
- A private module path sent to a public proxy can disclose the path without creating code substitution; keep privacy and integrity effects separate.

Report only when attacker-controlled module content can be selected or accepted without the expected integrity/source constraint and reaches build or execution.
