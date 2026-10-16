# Object Construction From Serialized Data

Use this reference when untrusted serialized data can select runtime types, constructors, hooks, or executable object behavior. For external entities, includes, expansion, or other parser features, use `parser-capabilities.md`.

## Sources

- Request bodies, uploaded files, cookies, session fields, queue messages, cache entries, webhooks, external API payloads, repository import/export files, and admin-configurable integration data.
- Local config and fixtures are not attacker-controlled unless the repository exposes a path for untrusted modification.

## Sinks

- Python: `pickle.load` / `pickle.loads`, `marshal`, unsafe `yaml.load`, dynamic import or object hooks driven by untrusted data.
- YAML: explicit tags, custom constructors and language-object tags can select object types or invoke construction behavior. Data-only safe loaders are a counterexample when no later dynamic construction occurs.
- JSON: polymorphic type metadata, default typing, class-name fields and object hooks can turn a data format into object construction. Verify the configured resolver, allowed types and library version.
- PHP: `unserialize` on request/cookie/upload data, especially without `allowed_classes`.
- Java: `ObjectInputStream`, unsafe polymorphic JSON typing, framework-specific type metadata such as `@type` when reachable from untrusted input.
- .NET: `BinaryFormatter`, `NetDataContractSerializer`, `ObjectStateFormatter`, unsafe ViewState patterns.

## Guards

- Prefer safe data formats and schema validation over object deserialization.
- Use data-only parsers, safe YAML loaders and explicit allowed classes/types. Verify signatures only when they cover the exact payload before object construction.
- A guard only covers the object set it actually checks; type allowlists, signatures, and schema validation must be tied to the same parsed representation.

## Report Conditions

- Show untrusted serialized input reaching a dangerous parser or object reconstruction sink.
- Explain the security effect: code execution, object injection, state tampering, or privileged action.
- If object-deserialization exploitation depends on a gadget chain or deployment library behavior not established by repository evidence, use a lower-confidence verdict with proof gaps rather than confirmed vulnerability.

## False-Positive Precedents

- Parsing trusted local config is not a vulnerability by itself.
- Safe YAML/JSON parsing plus schema validation is not unsafe deserialization by itself.
- A JSON or YAML format name does not establish data-only behavior; inspect enabled type metadata, tags, constructors and hooks.
- Dependency presence alone does not prove reachability.
- A theoretical gadget chain is not enough without an untrusted deserialization path and relevant classes or framework behavior.
