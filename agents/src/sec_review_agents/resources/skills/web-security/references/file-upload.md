# File Upload Reference

Use this reference for user-uploaded files, filenames, archive contents, media/document processing, public serving, parser handoff, and storage paths.

## Sources

- Multipart uploads, import/export files, avatars, attachments, documents, archives, images, media, plugins, themes, templates, model files, and tenant-controlled generated files.
- Uploaded filename, extension, content type, MIME sniff result, metadata, archive entry path, parser output, and storage key.
- Files fetched from remote URLs on behalf of a user and then stored or processed.

## Sinks

- Filesystem writes, object storage writes, public/static serving, download endpoints, extraction, parser/converter execution, image/PDF/media processing, template/plugin loading, and malware-sensitive handoff to other systems.
- Server-side script execution paths, web roots, user-controllable extensions, symlinks/hardlinks in archives, path traversal in filenames, and size/resource usage limits.
- Content displayed inline in browsers with attacker-controlled type or disposition.

## Guards

- Store uploads outside executable web roots or serve them from isolated domains/buckets with safe content disposition.
- Use strict allowlists for type and extension, verify actual content where material, and avoid trusting client-provided `Content-Type`.
- Generate server-side filenames/storage keys; do not use raw user filenames for paths or URLs without safe normalization.
- Enforce size, count, decompressed size, recursion, and parser resource limits.
- For archives, reject absolute paths, parent traversal, symlinks/hardlinks, duplicate normalized names, and paths escaping the extraction root.
- Run risky parsers/converters in a sandbox without secrets or privileged filesystem/network access.

## Report Conditions

Report only when repository evidence shows:

- attacker-controlled file content, metadata, name, path, or archive entry;
- a reachable storage, serving, extraction, parser, or execution sink;
- missing or insufficient validation/isolation for that sink;
- concrete impact such as server-side code execution, stored XSS, path traversal/write, sensitive file overwrite/read, known vulnerable parser behavior, unsafe parser feature, resource exhaustion, XXE, macro/script execution, privileged parser exposure, or unsafe public disclosure.

## False-Positive Precedents

- A generic upload endpoint is not vulnerable solely because uploads are allowed.
- Extension validation is not enough by itself, but do not report unless bypass or dangerous sink is repository-grounded.
- Public file serving can be acceptable if content is inert, isolated, and served with safe type/disposition.
- Client-side file type checks are not security guards; server-side checks determine confirmation.
- Parser library presence is not a finding without attacker-controlled content reaching the parser in a dangerous context.
