# Input Bundle Artifact

Language: English | [中文](README.zh.md)

This directory defines the immutable archive that carries prepared review input from an Execution API caller to the Execution Worker. It is a profile over the shared [envelope v1](../../envelope/v1/SPEC.md).

- [v1/SPEC.md](v1/SPEC.md) defines the tree, canonical production rules, and resource limits.
- [v1/corpus](v1/corpus) contains real archives that every input-bundle consumer executes in addition to the shared envelope corpus.

The Execution API owns the reference object and workflow-specific manifest schema. This profile owns the archive representation and tree boundary; it does not define preparation retry or object-storage lifecycle policy.

## Tooling

```bash
pnpm run generate
pnpm run check
pnpm run test
```

Run these commands from `contracts/tar-zstd-artifact/profiles/input-bundle/tools/`.
