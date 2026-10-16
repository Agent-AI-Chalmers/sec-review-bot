# Parser And Protocol Security Source Notes

Reviewed 2026-10-16. The skill covers interpretation boundaries and selected parser capabilities, not every format or protocol. Defaults must match the repository's library and version.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| PARSE-1: representation agreement; `representation-boundaries.md` | [MITRE CWE-20](https://cwe.mitre.org/data/definitions/20.html), Potential Mitigations and canonicalization guidance | Validation must apply to the representation consumed. This does not prescribe repeated canonicalization or one universal form. |
| PARSE-2: HTTP/1.1 length; `http-framing.md` | [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html), §6.3 | Recipients must determine body length consistently. Apply only to HTTP/1.1 and relevant downgrade paths. |
| PARSE-3: smuggling impact; `http-framing.md` | RFC 9112, §11.2 | Differential parsing can leave bytes for another request. Conflicting headers alone are insufficient without recipient disagreement and connection behavior. |
| PARSE-4: XML resources; `parser-capabilities.md` | [OWASP XXE Prevention](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html), examples and parser guidance | External resource resolution differs from expansion and object construction. Actual defaults are parser/version-specific. |
| PARSE-5: context substitution; `representation-boundaries.md` | [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), §§2.7-2.8 and 3.8-3.12 | Integrity does not establish audience or token type. This is not a universal replay/state checklist. |

Format names, malformed input and parser API presence are leads. Confirmation requires attacker input, enabled interpretation/capability, an ineffective guard and concrete effect.
