# Input Bundle Artifact - v1

Language: English | [中文](SPEC.zh.md)

## Envelope

A v1 input bundle uses the restricted POSIX PAX [envelope v1](../../../envelope/v1/SPEC.md).

| Property | Required value |
| --- | --- |
| Media type | `application/tar+zstd` |
| Digest | lowercase `sha256` of the actual compressed archive bytes |
| Maximum compressed archive size | 2 GiB (`2,147,483,648` bytes) |
| Maximum entry count | 100,000, including files and directories |
| Maximum total regular-file size | 8 GiB (`8,589,934,592` bytes) |

The Execution API reference binds the URI, media type, compressed-byte size, and digest. Storage location is owned by the caller's storage contract rather than this archive profile.

## Required Tree

The archive contains:

```text
manifest.json
workspace.snapshot.tar
history/
history/**                    (optional)
incremental-window/          (optional as a whole)
incremental-window/**        (optional)
```

`manifest.json` is the first entry and is a UTF-8 JSON document conforming to the Execution API v1 `input-bundle-manifest.schema.json`. It names `workspace.snapshot.tar`, `history`, and, when present, `incremental-window` through bundle-relative paths.

The workspace snapshot is deliberately an uncompressed tar nested inside the transport archive. Execution stages reuse it to create isolated workspaces. This profile treats its bytes as opaque; the workspace snapshot contract is enforced when a stage materializes it.

Only regular files and directories are allowed. Paths are relative UTF-8 paths using `/`. Empty segments, `.` and `..` segments, absolute paths, backslashes, NUL bytes, and duplicate effective paths are forbidden. Regular-file paths have no trailing slash; directory paths have exactly one trailing slash. Every non-root path has an explicit parent-directory entry.

No path outside the tree above is allowed.

## Entry Metadata And Ordering

Every entry has canonical metadata:

| Field | Regular file | Directory |
| --- | --- | --- |
| `mtime` | `0` | `0` |
| `uid`, `gid` | `0`, `0` | `0`, `0` |
| `uname`, `gname` | empty | empty |
| mode | `0644` | `0755` |
| size | actual byte length | `0` |

`manifest.json` is first. Every remaining entry is ordered by ascending bytewise lexical order of its canonical UTF-8 path. The envelope's local PAX `path` header is used only when the effective path does not fit ordinary ustar fields.

## Production And Consumption

Producers emit exactly the required metadata and ordering, then compress the tar stream as one Zstandard frame. The contract does not pin a compressor implementation or compression level: artifact identity is the digest of the actual compressed bytes. For the same entry paths and bodies, one producer configuration must reproduce the same compressed bytes across retries.

Consumers verify reference size and digest before decompression, validate the shared envelope and this profile before extraction, and enforce entry-count and extracted-byte limits while parsing. They must not extract links, special entries, non-canonical paths, or entries whose metadata violates this profile.

## Shared Corpus

[corpus/manifest.json](corpus/manifest.json) records real valid and invalid archives. The cases cover the minimal and incremental trees, canonical ordering and metadata, required paths, unexpected paths, and symbolic links. Every input-bundle consumer executes these bytes in addition to the envelope corpus.
