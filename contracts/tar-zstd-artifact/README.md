# Tar+Zstandard Artifact Envelope

Language: English | [中文](README.zh.md)

This family defines the shared archive envelope used by project-owned artifacts whose media type is `application/tar+zstd`. It does not define an artifact's internal files, manifest, limits, or storage key; those remain with each artifact profile.

- [v1/SPEC.md](v1/SPEC.md) defines the restricted POSIX PAX dialect.
- [v1/corpus](v1/corpus) contains encoded interoperability and rejection cases consumed by every archive reader.

Memory-tree and run-diagnostic contracts are profiles over this envelope. Their profile versions remain independent from the envelope version.
