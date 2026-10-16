# Path Traversal Source/Sink Reference

Use this reference when a lead involves attacker-influenced paths, filenames, archive entries, filesystem reads/writes, downloads, or static file serving.

## Sources

- Request path segments, query params, route params, form fields, JSON fields, upload filenames, archive entry names, import/export names, template names, and user-controlled object keys.
- Repository paths or config paths only when attacker influence or tenant/user control is established.

## Sinks

- File reads/writes/deletes, directory listings, downloads, static file serving, archive extraction, template loading, include/import resolution, and path-based access control checks.
- Path joins that combine trusted roots with untrusted names.
- Fallback paths, symlink-following behavior, generated path normalization, and extension/type checks.

## Guards

- Establish containment for the object actually accessed. For pathname-based guards, inspect decoding, normalization, root comparison, separators, case sensitivity where relevant, and link resolution using the target platform semantics.
- A resolved path checked before a later open/write is not sufficient when an attacker can replace a relevant directory, link, or target in between. Inspect whether constrained resolution, stable directory/file handles, or equivalent controls bind the operation to the authorized object; verify the exact API and flags rather than assuming that a handle or no-follow option covers every path component.
- Use allowlisted object identifiers when possible instead of raw paths.
- Archive extraction should reject absolute paths, parent traversal, symlinks/hardlinks when unsafe, and duplicate or normalized conflicting entries.

## Report Conditions

- Show the attacker-controlled path component, the filesystem or template sink, and the missing or insufficient containment/normalization guard.
- Distinguish arbitrary file read/write from narrower file selection bugs.
- Do not report when the path is a trusted deployment/config value unless repository evidence shows attacker control.

## False-Positive Precedents

- Merely joining strings into a path is not a vulnerability if the input is not attacker-controlled or the resolved target is contained by a verified guard.
- Extension checks, basename extraction, or string prefix checks do not by themselves establish containment. A safe handle-based operation need not first construct a canonical pathname; verify its object and resolution constraints.
- UI-visible filenames or client-side path strings are only leads; trusted-side file operations determine exploitability.
