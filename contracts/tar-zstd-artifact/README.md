# Tar+Zstandard Artifacts

Language: English | [中文](README.zh.md)

This family defines the shared archive envelope used by project-owned artifacts whose media type is `application/tar+zstd`, together with the profiles that define each artifact's internal organization.

- [envelope/v1/SPEC.md](envelope/v1/SPEC.md) defines the restricted POSIX PAX dialect.
- [envelope/v1/corpus](envelope/v1/corpus) contains encoded interoperability and rejection cases consumed by every archive reader.
- [profiles/memory-tree](profiles/memory-tree/README.md) defines immutable memory-tree archives.
- [profiles/input-bundle](profiles/input-bundle/README.md) defines prepared execution input archives.
- [profiles/run-diagnostic](profiles/run-diagnostic/README.md) defines completed-run diagnostic archives.

Envelope and profile versions are independent. Each profile specification names the envelope version it uses.

## Tooling

Run each tool from the directory that owns its layer:

```bash
pnpm --dir contracts/tar-zstd-artifact/envelope/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/memory-tree/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/input-bundle/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/run-diagnostic/tools run check
```
