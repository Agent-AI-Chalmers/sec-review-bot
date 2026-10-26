# Memory Tree Artifact

Language: English | [中文](README.zh.md)

This family defines the portable, content-addressed archive used to store one rendered memory tree. It is shared by the producer that publishes a tree and every service that validates or extracts one.

Its compression and tar representation follow the shared [envelope v1](../../envelope/v1/SPEC.md); this directory defines the memory-tree profile inside that envelope.

## Contract

- [v1/SPEC.md](v1/SPEC.md) defines the archive layout, limits, canonical tar metadata, compression, digest, and object key.
- [v1/manifest.schema.json](v1/manifest.schema.json) defines the exact JSON shape of the archive's top-level `manifest.json`.
- [v1/corpus](v1/corpus) contains real compressed archives and a readable manifest recording each case's purpose, entry count, digest, byte size, and expected validation result. Ordinary cases also list their ordered entries; large stress cases may retain only aggregate entry metadata.

## Ownership

The artifact producer owns canonical construction. Every consumer must enforce the complete archive boundary before extraction; object-store trust or a matching digest does not make archive paths or entry types safe.

## Tooling

Run from `tools/`:

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

`generate` writes the shared corpus archives and manifest. `check` regenerates them in a temporary directory and compares exact bytes.
