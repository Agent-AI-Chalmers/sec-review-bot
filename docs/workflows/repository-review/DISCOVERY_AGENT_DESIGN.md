# Discovery Agent Design Principles

Language: English | [中文](DISCOVERY_AGENT_DESIGN.zh.md)

## Role

Discovery is the screening stage of repository review. Its purpose is to surface security clues worth deeper investigation while keeping cost bounded and scan coverage explainable.

This stage produces candidates, not vulnerability conclusions. A candidate should identify a concrete repository location, suspicious behavior, and initial evidence, but it may remain uncertain. Triage later decides whether to keep, suppress, or merge it, and analyzer confirms or rejects the issue using broader context.

Discovery therefore does not classify `vulnerability_type` or CWE, merge cross-file root causes, or produce final reports. Nor does it ask one agent to explore and understand the entire repository freely. It performs repeatable screening over an explicit file scope and bounded local context.

## Scan Scope

Discovery focuses on files that may directly encode program behavior or a security boundary. Being readable as UTF-8 does not by itself make a file useful for initial screening. Scan scope has three distinct boundaries.

### `paths_ignore`

`paths_ignore` expresses an explicit repository-maintainer exclusion. It is a setting for this scan's repository scope and is distinct from the project's default file-kind policy.

### File-Kind Policy

File selection uses a denylist rather than a programming-language allowlist. Repositories may contain uncommon languages, DSLs, extensionless scripts, or project-specific formats. An allowlist would accumulate omissions as repository types change, so readable files with unknown extensions or no extension remain eligible by default.

The following files do not initiate discovery by default:

- Markdown and reStructuredText: `.md` and `.rst`;
- plain text: `.txt` and `.text`;
- tabular data: `.csv` and `.tsv`;
- logs: `.log`.

This is an input-selection policy, not a read-capability limit. These files may still become useful context in a later stage when there is a concrete candidate and a specific retrieval target.

A document does not enter discovery merely because it is named `SECURITY.md`, `threat-model.md`, or similarly. A filename suggests a topic but does not establish a relationship with code or security behavior. Reconsider the document boundary only if a reliable code-association mechanism can establish that relationship through code, build configuration, or an explicit dependency.

YAML, JSON, SQL, XML, and HTML remain eligible. They may be ordinary data, but they can also directly encode deployment, authorization, policy, query, template, or data boundaries. Excluding them solely by extension would remove real security coverage.

Scan results should let readers distinguish an intentional repository exclusion, a policy exclusion, a resource limit, and an unreadable file rather than reducing all of them to “not scanned.”

### Per-File Size Protection

Before reading a file, discovery applies `AGENT_DISCOVERY_MAX_FILE_BYTES`, with a default of 256 KiB. This is a worker resource boundary for reading, decoding, and prompt construction, not a model context boundary; byte size has no stable conversion to tokens, so exceeding it does not mean the model necessarily could not accept the file.

This limit belongs to the service environment rather than an individual review's scan scope. It is absent from the public `scan_scope` contract, so a caller cannot relax the worker safety boundary for one request. There is currently no evidence for changing the 256 KiB default; reconsider it only when a source file worth scanning is demonstrably excluded, using that concrete sample and its resource cost.

## Chunk Design

There are two direct ways to organize discovery input.

Option A gives each discovery agent one file. Its advantage is concentrated attention and a sharply defined code scope for every call. The tradeoff is that every file requires a separate model call and reloads the system prompt, output schema, and other fixed context. In a repository with many small files, that repeated overhead can materially increase cost. A single-file view also provides no local cross-file context by itself.

Option B groups several files into a chunk and gives each discovery agent one chunk. This amortizes fixed prompt cost and preserves some cross-file context. The corresponding risk is that larger chunks ask the model to attend to more material at once. Experiments also show that a long context can reduce security-clue recall even when the request remains below the maximum input limit.

The current default chooses option A (`single-file`) so each model call has a sharply bounded code scope and concentrated attention. Option B (`batched`) remains available as a worker-side deployment setting through `AGENT_DISCOVERY_CHUNK_STRATEGY`; it is not selectable by a review request. When batching is enabled, the target for an ordinary chunk is one fifth of the selected model's measured context-window input limit, leaving explicit room between efficient batching and concentrated attention.

The design uses two token boundaries:

| Input shape | Boundary | Behavior |
| --- | --- | --- |
| Ordinary multi-file chunk | One fifth of the selected model context-window input limit | Files are grouped until the next file would exceed this target. |
| Single-file chunk | Four fifths of the selected model context-window input limit | A file that exceeds the ordinary target may still be scanned alone, with the remaining fifth reserved for runtime overhead. |
| Over the single-file limit | Above four fifths of the selected model context-window input limit | The file is skipped as exceeding the discovery token budget. |

One fifth constrains ordinary multi-file chunks; it must not prevent a complete file from being scanned. A file that exceeds the ordinary target but remains within the single-file hard limit still forms its own chunk. Only a file above the hard limit cannot enter discovery.

The hard limit leaves the remaining one fifth for runtime-added schemas, skill guidance, tool turns, and token-estimation error. Files remain whole rather than being split to satisfy the target. This avoids breaking local semantics at arbitrary positions and keeps candidate locations and scan coverage easier to interpret.

All token boundaries come from the selected model's measured context-window input limit. Prompt size refers to the complete request, including system and user prompts, file metadata, and file contents.
