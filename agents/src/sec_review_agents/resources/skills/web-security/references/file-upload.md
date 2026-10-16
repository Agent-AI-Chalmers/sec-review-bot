# File Upload Reference

Use this reference for the web boundary of user-uploaded files: admission, storage identity, public serving, browser interpretation and handoff to downstream processors.

## Sources

- Multipart uploads, import/export files, avatars, attachments, documents, archives, images, media, plugins, themes, templates, model files, and tenant-controlled generated files.
- Uploaded filename, extension, content type, MIME sniff result, metadata and storage key.
- Files fetched from remote URLs on behalf of a user and then stored or processed.

## Sinks

- Object storage writes, public/static serving, download endpoints, inline browser rendering, executable web roots and handoff to extraction, parsing, conversion, template, plugin or media-processing components.
- Storage identity derived from attacker-controlled names, extensions, types or metadata.
- Content displayed inline in browsers with attacker-controlled type or disposition.

## Guards

- Store uploads outside executable web roots or serve them from isolated domains/buckets with safe content disposition.
- Use strict allowlists for type and extension, verify actual content where material, and avoid trusting client-provided `Content-Type`.
- Generate server-side storage identifiers when raw filenames do not need to remain authoritative.
- At a processor handoff, identify the exact bytes and metadata passed downstream, the selected processor and the authority available to it. Apply the downstream mechanism's own parser, filesystem, execution or resource rules rather than treating upload status as proof of safety or danger.

## Report Conditions

Report only when repository evidence shows:

- attacker-controlled file content, metadata, name or type;
- a reachable storage, serving, browser-execution or downstream handoff boundary;
- missing or insufficient validation or isolation at that web boundary;
- concrete impact such as executable upload, stored XSS, unauthorized public disclosure, attacker-selected storage identity, or a repository-grounded dangerous downstream operation.

## False-Positive Precedents

- A generic upload endpoint is not vulnerable solely because uploads are allowed.
- Extension validation is not enough by itself, but do not report unless bypass or dangerous sink is repository-grounded.
- Public file serving can be acceptable if content is inert, isolated, and served with safe type/disposition.
- Client-side file type checks are not security guards; server-side checks determine confirmation.
- Handoff to a parser, converter or archive extractor is only a lead until the downstream mechanism and concrete effect are established.
