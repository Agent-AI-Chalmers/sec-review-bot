---
name: parser-protocol-security
description: "Use for representation or framing disagreements, validation/consumption interpretation gaps, dangerous parser capabilities, and protocol context binding. A format name or malformed input alone is not proof."
---

# Parser And Protocol Security

- For decoding, normalization, canonicalization and validation/consumption representation gaps: read `/skills/parser-protocol-security/references/representation-boundaries.md`.
- For HTTP/1.1 message length, forwarding and differential request framing: read `/skills/parser-protocol-security/references/http-framing.md`.
- For external resources, entity expansion and parser feature/default questions: read `/skills/parser-protocol-security/references/parser-capabilities.md`.
- For untrusted serialized data that selects runtime types, constructors, hooks or executable object behavior: read `/skills/parser-protocol-security/references/object-construction.md`.
- For archive member names, links, duplicate entries, metadata and extraction interpretation: read `/skills/parser-protocol-security/references/archive-semantics.md`.
- For attacker input compiled or evaluated as template, expression, query or policy language: read `/skills/parser-protocol-security/references/expression-interpreters.md`.

Identify each interpreter, transformation and downstream security decision. Use the specification for the actual protocol/version and the documentation for the configured parser version.
