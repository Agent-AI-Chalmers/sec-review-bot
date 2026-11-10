# Discovery Agent Design Principles

Language: English | [中文](DISCOVERY_AGENT_DESIGN.zh.md)

## Role

Discovery is the screening stage of repository review. Its purpose is to surface security clues worth deeper investigation while controlling cost and keeping scan coverage explainable.

This stage produces candidates, which are leads and not confirmed vulnerabilities. A candidate should identify a concrete repository location, suspicious behavior, and initial evidence, but it may remain uncertain. Triage later decides whether to keep, suppress, or merge it, and analyzer confirms or rejects the issue using broader context.

Discovery therefore does not classify `vulnerability_type` or CWE, merge cross-file root causes, or produce final reports. No single agent explores the whole repository freely. Discovery performs repeatable screening over an explicit file scope and the local context assembled for that scope.

## Scan Scope

Discovery focuses on files that may directly encode program behavior or a security boundary. Being readable as UTF-8 does not by itself make a file useful for initial screening. Scan scope has the following boundaries.

### `paths_ignore`

`paths_ignore` expresses an explicit repository-maintainer exclusion. It is a setting for this scan's repository scope and is distinct from the project's default file-kind policy.

### File-Kind Policy

File selection uses a denylist rather than a programming-language allowlist. Repositories may contain uncommon languages, DSLs, extensionless scripts, or project-specific formats. An allowlist would accumulate omissions as repository types change, so readable files with unknown extensions or no extension remain eligible by default.

The following files do not initiate discovery by default:

- Markdown and reStructuredText: `.md` and `.rst`;
- plain text: `.txt` and `.text`;
- tabular data: `.csv` and `.tsv`;
- logs: `.log`.

This policy controls which files start discovery. It does not stop later stages from reading these files: they may still become useful context in a later stage when there is a concrete candidate and a specific retrieval target.

A document does not enter discovery merely because it is named `SECURITY.md`, `threat-model.md`, or similarly. A filename suggests a topic but does not establish a relationship with code or security behavior. Reconsider the document boundary only if a reliable code-association mechanism can establish that relationship through code, build configuration, or an explicit dependency.

YAML, JSON, SQL, XML, and HTML remain eligible. They may be ordinary data, but they can also directly encode deployment, authorization, policy, query, template, or data boundaries. Excluding them solely by extension would remove real security coverage.

Scan results should let readers distinguish an intentional repository exclusion, a policy exclusion, a resource limit, and an unreadable file, instead of reporting all of them as "not scanned."

### Per-File Size Protection

<!-- doc-default: AGENT_DISCOVERY_MAX_FILE_BYTES; source=agents/src/sec_review_agents/scan_stages/discovery/stage.py -->

Before reading a file, discovery applies `AGENT_DISCOVERY_MAX_FILE_BYTES`, with a default of 256 KiB. The limit protects worker resources during reading, decoding, and prompt construction. It says nothing about the model context: byte size has no stable conversion to tokens, so a file over the limit might still fit in the model's input.

<!-- doc-default: AGENT_DISCOVERY_MAX_FILE_BYTES; source=agents/src/sec_review_agents/scan_stages/discovery/stage.py -->

This limit belongs to the service environment, not to an individual review's scan scope. It is absent from the public `scan_scope` contract, so a caller cannot relax the worker safety boundary for one request. There is currently no evidence for changing the 256 KiB default; reconsider it only when a source file worth scanning is demonstrably excluded, using that concrete sample and its resource cost.

## Chunk Design

Discovery input supports these organization strategies.

The `single-file` strategy gives each discovery agent one file. Its advantage is concentrated attention and a sharply defined code scope for every call. The tradeoff is that every file requires a separate model call and reloads the system prompt, output schema, and other fixed context. In a repository with many small files, that repeated overhead can materially increase cost. A single-file view also provides no local cross-file context by itself.

The `batched` strategy groups several files into a chunk and gives each discovery agent one chunk. This amortizes fixed prompt cost and preserves some cross-file context. The corresponding risk is that larger chunks ask the model to attend to more material at once. Staying below the input limit does not guarantee equal attention to each file; evaluate that tradeoff with concrete cases.

<!-- doc-default: AGENT_DISCOVERY_CHUNK_STRATEGY; source=agents/src/sec_review_agents/scan_stages/discovery/stage.py -->

The current default is `single-file`, so each model call focuses on one file. `batched` remains available as a worker-side deployment setting through `AGENT_DISCOVERY_CHUNK_STRATEGY`; it is not selectable by a review request. When batching is enabled, the target for an ordinary chunk is one fifth of the input token limit (`max_input_tokens`) configured for the selected deployment, which trades some batching efficiency for more concentrated attention.

Discovery applies an ordinary chunk target and a single-file hard limit:

| Input shape                | Boundary                                                                    | Behavior                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ordinary multi-file chunk  | One fifth of the selected deployment’s configured input token limit         | Files are grouped until the next file would exceed this target.                                                             |
| Single-file chunk          | Four fifths of the selected deployment’s configured input token limit       | A file that exceeds the ordinary target may still be scanned alone, with the remaining fifth reserved for runtime overhead. |
| Over the single-file limit | Above four fifths of the selected deployment’s configured input token limit | The file is skipped as exceeding the discovery token budget.                                                                |

The one-fifth target applies only to ordinary multi-file chunks and must not prevent a complete file from being scanned. A file that exceeds the ordinary target but remains within the single-file hard limit still forms its own chunk. Only a file above the hard limit cannot enter discovery.

The hard limit leaves the remaining one fifth for runtime-added schemas, skill guidance, tool turns, and token-estimation error. Discovery never splits a file to satisfy the target. Keeping files whole avoids breaking local semantics at arbitrary positions and keeps candidate locations and scan coverage easier to interpret.

All token boundaries come from the input token limit (`max_input_tokens`) configured for the selected deployment. Prompt size refers to the complete request, including system and user prompts, file metadata, and file contents.

### Experimental Evidence

The original experimental note reported a recall advantage for `single-file`. One possible explanation is that concentrating each call on one file reduces dilution of local security clues by multi-file context. Discovery provides investigation leads; later stages reconstruct cross-file chains. However, the note did not provide a date, model version, code revision, or locatable results, so it cannot establish the same benefit for other models or repositories. Compare candidate recall, false signals, total cost, and downstream reconstruction of cross-file issues with fixed inputs and models before changing strategy.
