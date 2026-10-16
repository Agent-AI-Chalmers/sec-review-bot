# Parser And Protocol Security Source Notes

Reviewed 2026-10-16. The skill covers interpretation boundaries and selected parser capabilities, not every format or protocol. Defaults must match the repository's library and version.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| PARSE-1: representation agreement; `representation-boundaries.md` | [MITRE CWE-20](https://cwe.mitre.org/data/definitions/20.html), Potential Mitigations and canonicalization guidance | Validation must apply to the representation consumed. This does not prescribe repeated canonicalization or one universal form. |
| PARSE-2: HTTP/1.1 length; `http-framing.md` | [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html), §6.3 | Recipients must determine body length consistently. Apply only to HTTP/1.1 and relevant downgrade paths. |
| PARSE-3: smuggling impact; `http-framing.md` | RFC 9112, §11.2 | Differential parsing can leave bytes for another request. Conflicting headers alone are insufficient without recipient disagreement and connection behavior. |
| PARSE-4: XML resources; `parser-capabilities.md` | [OWASP XXE Prevention](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html), examples and parser guidance | External resource resolution differs from expansion and object construction. Actual defaults are parser/version-specific. |
| PARSE-5: context substitution; `representation-boundaries.md` | [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), §§2.7-2.8 and 3.8-3.12 | Integrity does not establish audience or token type. This is not a universal replay/state checklist. |
| PARSE-6: object construction versus data parsing; `object-construction.md` | [OWASP Deserialization](https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html), language-specific prevention sections; [CWE-502](https://cwe.mitre.org/data/definitions/502.html) | Identify reachable types, constructors or hooks and a concrete security effect. A format name or parser API alone is only a lead; runtime gadget availability and defaults need repository/library evidence. |
| PARSE-7: guard scope; `object-construction.md` | OWASP Deserialization Cheat Sheet, language-specific prevention sections | Data-only parsing, type allowlists, schemas and signatures address different mechanisms. Verify that the control covers the same bytes and object-construction path. |

Format names, malformed input and parser API presence are leads. Confirmation requires attacker input, enabled interpretation/capability, an ineffective guard and concrete effect.

## Coverage and deferred work

Current coverage: validation/consumption representation gaps, HTTP/1.1 framing, XML external resources/entity expansion, unsafe object construction and token-context substitution. Deferred: HTTP/2 and HTTP/3 downgrade specifics, gRPC framing, archive-format catalogs, media/compiler parsers and general replay/state-machine rules. Each needs its own protocol or parser source before inclusion.
