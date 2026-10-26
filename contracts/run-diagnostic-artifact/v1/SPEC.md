# Run Diagnostic Artifact - v1

Language: English | [中文](SPEC.zh.md)

## Envelope

The artifact uses the restricted POSIX PAX [tar-zstd-artifact v1 envelope](../../tar-zstd-artifact/v1/SPEC.md) and media type `application/tar+zstd`. Its filename is `diagnostic-tree.v1.tar.zst`.

## Tree

The archive contains `manifest.json`, `result.json`, and an `artifact-tree/` directory holding the run's persisted diagnostic files. Only regular files and directories are allowed. Paths are relative, use `/`, contain no empty, `.` or `..` segments, and do not use backslashes. Duplicate effective paths are invalid.

The manifest is a UTF-8 JSON object with `version: 1`, the owning `run_id`, `result: "result.json"`, and a `review_units` array. Each review unit has a unique string `id` and a `transcripts` array whose paths are files below `artifact-tree/`. Every listed transcript must exist in the archive.

`result.json` must contain valid UTF-8 JSON. Consumers may impose role-specific preview limits below the publication limits, but they enforce the envelope before interpreting either JSON document.

## Production

Producers normalize `mtime`, `uid`, `gid`, `uname`, and `gname`, exclude the publication directory and symbolic links from `artifact-tree/`, explicitly select POSIX PAX output, and validate the completed archive against the shared envelope before publication.
