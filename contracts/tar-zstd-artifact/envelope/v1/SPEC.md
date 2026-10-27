# Tar+Zstandard Artifact Envelope - v1

Language: English | [中文](SPEC.zh.md)

## Scope

This contract defines only the representation shared by project-owned `application/tar+zstd` artifacts. A profile defines the allowed tree, semantic metadata, canonical ordering, resource limits, and producer policy.

## Compression

The payload is one Zstandard frame containing one tar archive. A profile may impose tighter compressed and decompressed size limits. Consumers reject malformed compression and, when their decoder exposes the distinction, concatenated frames or trailing non-frame data.

## Restricted POSIX PAX Dialect

The tar stream uses POSIX ustar headers with an optional local PAX extended header (`typeflag` `x`) immediately before the member it modifies. A member representable directly by ustar does not need an extended header and remains part of this PAX dialect.

The supported PAX subset is deliberately small:

- a local extended header contains exactly one record whose key is `path`;
- a local extended header is at most 1 MiB;
- the record length is exact, the record ends in LF, and the value is valid UTF-8;
- the `path` value replaces the following member's ustar name and prefix fields;
- consecutive or orphan local extended headers are invalid;
- global PAX headers (`g`), unknown PAX keys, duplicate `path` records, GNU long-name (`L`), GNU long-link (`K`), and GNU sparse (`S`) extensions are invalid.

Consumers validate the effective path after applying `path`; placeholder names in the underlying ustar member have no authority.

## Canonical Entries

Only regular files and directories are allowed. Every entry has canonical metadata:

| Field | Regular file | Directory |
| --- | --- | --- |
| `mtime` | `0` | `0` |
| `uid`, `gid` | `0`, `0` | `0`, `0` |
| `uname`, `gname` | empty | empty |
| mode | `0644` | `0755` |
| size | actual body length | `0` |

Profiles define which files and directories are allowed, but cannot relax these shared entry rules.

## Tar Structure

Every header has a valid checksum and POSIX ustar magic. Entry bodies are padded to 512-byte blocks. The archive ends with at least two zero blocks, and later bytes are zero padding only.

## Producer Rule

Producers use ordinary ustar fields when the effective path fits them and emit a local `path` header only when necessary. They do not emit optional timestamps, ownership keys, implementation-specific keys, or redundant PAX metadata.

## Shared Corpus

[corpus/manifest.json](corpus/manifest.json) identifies real `.tar.zst` byte streams that every consumer must accept or reject at this envelope boundary. Profile corpora separately cover internal layout and semantic rules.
