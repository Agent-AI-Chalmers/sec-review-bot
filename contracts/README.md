# Contracts

Language: English | [中文](README.zh.md)

This directory is the workspace-level home for project-owned contracts. It holds both the human-readable specification of a contract and the executable assets that enforce it.

## Layout

Each contract family owns one directory, and each supported version owns a subdirectory holding its specification, schemas, and fixtures:

```text
contracts/
  <family>/
    <version>/
      <SPEC>.md        the written contract for that version
      schemas/*.json   machine-checkable shapes (when the contract is shaped as data)
      fixtures/*.json  executable examples, plus the manifest that pairs them
      corpus/*         shared non-JSON inputs, plus a manifest, when the contract
                       is a format enforced by code rather than a data shape
  <layered-family>/
    envelope/<version>/{SPEC.md,corpus/}
    profiles/<name>/<version>/{SPEC.md,corpus/}
```

Not every family uses every kind of asset. A contract whose rules are decision logic rather than a structural shape carries a `corpus/` instead of `schemas/` and `fixtures/`, and enforces the format in code. See
[setup-declaration](setup-declaration/README.md) for that shape.

A family may also hold documents that apply to every version, such as a transport reference.

When several formats share a real lower-level representation, one family may make that relationship explicit with independently versioned `envelope/` and `profiles/<name>/` directories. Each layer owns its own specification, corpus, and tooling; nesting does not couple their version numbers. See [tar-zstd-artifact](tar-zstd-artifact/README.md).

## Families

| Family                                             | Boundary                                                     | Parties                                                         | Current version                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [execution-api](execution-api/README.md)           | Public HTTP operations, workflow inputs, results, and errors | Execution API providers, callers, and downstream publishers     | [v1](execution-api/v1/CONTRACT.md)                                                                                                                                                                   |
| [execution-workflow](execution-workflow/README.md) | Temporal Execution Workflow input                            | Execution Gateway and Execution Worker                          | [v1](execution-workflow/v1/CONTRACT.md)                                                                                                                                                              |
| [review-runs-api](review-runs-api/README.md)       | Review Runs HTTP API and observed run shapes                 | Review Runs and its callers                                     | [v1](review-runs-api/v1/openapi.yaml)                                                                                                                                                                |
| [memory-catalog-api](memory-catalog-api/README.md) | Memory coordination HTTP API                                 | Memory Catalog Server and workers                               | [v1](memory-catalog-api/v1/openapi.yaml)                                                                                                                                                             |
| [tar-zstd-artifact](tar-zstd-artifact/README.md)   | Shared archive envelope and its artifact profiles            | All project-owned tar+zstd producers and consumers              | [envelope v1](tar-zstd-artifact/envelope/v1/SPEC.md), [input-bundle v1](tar-zstd-artifact/profiles/input-bundle/v1/SPEC.md), [memory-tree v1](tar-zstd-artifact/profiles/memory-tree/v1/SPEC.md), [run-diagnostic v1](tar-zstd-artifact/profiles/run-diagnostic/v1/SPEC.md) |
| [setup-declaration](setup-declaration/README.md)   | Trusted `.sec-review/setup.yml` format                       | Reviewed repositories, GitHub Integration, and Execution Worker | [v1](setup-declaration/v1/SPEC.md)                                                                                                                                                                   |

## Rules For Every Family

A family is named for what it covers. If one component owns every shape in it, name it after that component — `review-runs-api` is Review Runs's own shapes. If the shapes span several parties, name it after where they meet — `execution-api` spans Execution providers, callers, and downstream publishers.

Do not name a family after one of its consumers: consumers change, the provider does not. And do not reuse a word that another family already uses for a different meaning.

The specification, its schemas, its fixtures, and the fixture manifest change together.

Schemas own the structural shape: required fields, JSON types, enums, tagged variants, and additional-field policy. They do not replace domain code. Cross-field rules stay with the workflow that makes the decision, and side-effect policy such as safe repository paths, platform permissions, publishing eligibility, and retry behavior stays with the consumer.

Fixtures are part of contract validation. The manifest records which valid fixtures each schema must accept and which invalid fixtures it must reject, so every implementation exercises the same structural boundary.

### Binary And Content-Addressed Artifacts

For an archive, compressed stream, or other content-addressed artifact, the specification must separate producer obligations from consumer obligations. State which representation producers must emit, which alternate representations consumers may accept, and which inputs every consumer must reject. Library defaults are implementation details, not contract rules.

An artifact reference must bind the declared media type, compressed-byte size, digest, and canonical storage location when the contract defines one. Consumers verify that reference shape and location first, then compressed size and digest, before decompression or semantic parsing. A trusted object store or matching digest does not replace validation of archive paths, entry types, metadata, limits, or internal manifests.

The contract family owns a shared corpus of real encoded bytes. It should cover valid interoperability cases, malformed structure, representation extensions, duplicate or ambiguous names, links and special entries, and concrete resource limits. Every consumer runs the same corpus. Every producer also has focused tests proving that it emits valid corpus-equivalent output and rejects inputs it cannot encode without leaving the canonical format.

Stress fixtures remain real artifacts, but their readable manifest may record aggregate facts such as `entryCount` instead of expanding thousands of repetitive entries. The fixture bytes and validator result remain the oracle.

Tests read fixtures through their package-local helper instead of hard-coding paths:

- Python: `tests.contract_fixtures`
- TypeScript: `test/contract-fixtures.ts`

Each family README records who owns which side of its boundary and what callers may rely on.

## Derived Artifacts

Some artifacts are generated from a hand-written contract rather than maintained by hand — a TypeScript projection of an API, committed JSON Schemas, a generated parameter list. Each owning family or layered-family component keeps the tool that renders and checks its projections in its local `tools/` directory, so the tool that reads a contract lives beside it and where its outputs land (which may be another package) does not change who owns the check. That tool's `generated-artifacts.json` lists what it derives and where it lands.

Name a stable package entry point for the responsibility callers consume, even when a generator maintains it (`execution-api-version.ts`, for example). Raw mechanical projections may carry `generated` in the filename when that helps distinguish files that should not accumulate hand-written behavior (`contract-types-generated.ts`, for example). The filename is not the enforcement boundary: every committed generated artifact must identify itself in its header, appear in the family manifest, and be covered by the freshness and CI checks below.

Each tool provides a local `generate` command to render every artifact and `check` to prove the committed copies match. A family's test asserts the manifest matches the generators' own declared outputs and that the CI change filter triggers on every listed artifact, so a new projection is covered by being listed, not by remembering to wire up a check.

## Change Checklist

For any contract change:

- update the specification for the affected version;
- update its schemas;
- update or add its fixtures and manifest entries;
- regenerate any derived artifact (such as the Review Runs's committed `v1` schemas and generated types) with the owning family or layer's local tool, then run its `check` command;
- make both the Python and TypeScript tests validate the same files.
- for binary artifacts, run producer tests, every consumer's shared-corpus tests, and at least one end-to-end reference-to-bytes validation path.
