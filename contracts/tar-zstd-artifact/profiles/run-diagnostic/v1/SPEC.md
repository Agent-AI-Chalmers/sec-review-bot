# Run Diagnostic Artifact - v1

Language: English | [中文](SPEC.zh.md)

## Envelope

The artifact uses the restricted POSIX PAX [envelope v1](../../../envelope/v1/SPEC.md) and media type `application/tar+zstd`. Its filename is `diagnostic-tree.v1.tar.zst`.

## Tree

The archive contains `manifest.json`, `result.json`, and an `artifact-tree/` directory holding the run's persisted diagnostic files. Only regular files and directories are allowed. Paths are relative, use `/`, contain no empty, `.` or `..` segments, and do not use backslashes. Duplicate effective paths are invalid.

The manifest is a UTF-8 JSON object with `version: 1`, the owning `run_id`, `result: "result.json"`, and a `review_units` array. Each review unit has a unique string `id` and a `transcripts` array. Transcript paths follow the same canonical relative-path rules as archive entries, name `.jsonl` files below `artifact-tree/`, and must exist in the archive.

`result.json` must contain valid UTF-8 JSON. Consumers may impose role-specific preview limits below the publication limits, but they enforce the envelope before interpreting either JSON document.

## Production

Producers apply the envelope's canonical entry rules, exclude the publication directory and symbolic links from `artifact-tree/`, explicitly select POSIX PAX output, and validate the completed archive against the shared envelope and this profile before publication.

## Shared Corpus

[corpus/manifest.json](corpus/manifest.json) records real valid and invalid run-diagnostic archives. Every consumer executes these bytes in addition to the envelope corpus. The cases cover the minimum valid tree, a valid PAX-carried transcript path, the manifest's result reference, missing transcripts, non-canonical transcript paths, transcript filename requirements, duplicate review-unit identities, and link entries.
