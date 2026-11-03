# Agent Transcript

Language: English | [中文](README.zh.md)

This family owns the JSONL transcript exchanged by agent runtimes, Memory readers, the UI, and usage-reporting scripts.

- [v1 specification](v1/SPEC.md) defines the boundary.
- [Record schema](v1/schemas/record.schema.json) defines the structural shape.
- [Shared corpus](v1/corpus/manifest.json) lists accepted and rejected complete inputs.

## Ownership and Enforcement

Producers emit canonical records. Consumers validate JSONL, record shapes, sequence order, message identities, and the consistency of supplied call relationships before using them. Missing terminal records can describe interrupted execution; malformed records are rejected.

Python and TypeScript run the same corpus through their own readers. Producer tests also check emitted records against the schema. No package reads another package's test directory.

There are no generated projections or family-specific generation tools. Changes to the schema, corpus, specification, and participating readers are reviewed together.
