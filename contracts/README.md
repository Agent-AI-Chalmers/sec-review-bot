# Contracts

Language: English | [中文](README.zh.md)

This directory maintains the interfaces and data-format agreements used between project packages. Each contract has its own directory containing the specification and the tools and data used for generation, validation, and tests.

## Package Workspace

<!-- doc-default: node-workspace; source=pnpm-workspace.yaml -->
The contract tools and `contracts/codegen` belong to the repository-root pnpm workspace, sharing its lockfile with applications and services. Contracts retains ownership of codegen; consumers explicitly declare `workspace:*` dependencies.

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run contracts:check
pnpm --filter "./contracts/**" run lint
pnpm --filter "./contracts/**" test
pnpm --filter @sec-review-bot/execution-api-tools run generate
```

Package-local commands remain available after installation. CI installs from the repository root and runs checks in each matrix package. Dependency changes should update the root `pnpm-lock.yaml`.

## Layout

Each contract owns one directory, and each supported version owns a subdirectory holding its specification, schemas, and fixtures:

```text
contracts/
  <contract>/
    <version>/
      <SPEC>.md        the written contract for that version
      schemas/*.json   machine-checkable shapes (when the contract is shaped as data)
      fixtures/*.json  executable examples, plus the manifest that pairs them
      corpus/*         shared non-JSON inputs, plus a manifest, when the contract
                       is a format enforced by code rather than a data shape
  <layered-contract>/
    envelope/<version>/{SPEC.md,corpus/}
    profiles/<name>/<version>/{SPEC.md,corpus/}
```

Not every contract uses every kind of asset. A contract whose rules are decision logic rather than a structural shape carries a `corpus/` instead of `schemas/` and `fixtures/`, and enforces the format in code. See [setup-declaration](setup-declaration/README.md) for that shape.

A contract may also hold documents that apply to every version, such as a transport reference.

When several formats share a real lower-level representation, one contract may make that relationship explicit with independently versioned `envelope/` and `profiles/<name>/` directories. Each layer owns its own specification, corpus, and tooling; nesting does not couple their version numbers. See [tar-zstd-artifact](tar-zstd-artifact/README.md).

## Contract Categories

| Contract                                             | Boundary                                                     | Parties                                                         | Current version                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [execution-api](execution-api/README.md)           | Public HTTP operations, workflow inputs, results, and errors | Execution API providers, callers, and downstream publishers     | [v1](execution-api/v1/CONTRACT.md)                                                                                                                                                                   |
| [execution-workflow](execution-workflow/README.md) | Temporal Execution Workflow input                            | Execution Gateway and Execution Worker                          | [v1](execution-workflow/v1/CONTRACT.md)                                                                                                                                                              |
| [review-runs-api](review-runs-api/README.md)       | Review Runs HTTP API and observed run shapes                 | Review Runs and its callers                                     | [v1](review-runs-api/v1/openapi.yaml)                                                                                                                                                                |
| [memory-catalog-api](memory-catalog-api/README.md) | Memory coordination HTTP API                                 | Memory Catalog Server and workers                               | [v1](memory-catalog-api/v1/openapi.yaml)                                                                                                                                                             |
| [tar-zstd-artifact](tar-zstd-artifact/README.md)   | Shared archive envelope and its artifact profiles            | All project-owned tar+zstd producers and consumers              | [envelope v1](tar-zstd-artifact/envelope/v1/SPEC.md), [input-bundle v1](tar-zstd-artifact/profiles/input-bundle/v1/SPEC.md), [memory-tree v1](tar-zstd-artifact/profiles/memory-tree/v1/SPEC.md), [run-diagnostic v1](tar-zstd-artifact/profiles/run-diagnostic/v1/SPEC.md) |
| [agent-transcript](agent-transcript/README.md) | Agent execution JSONL | Agent runtimes, Memory, UI, and usage scripts | [v1](agent-transcript/v1/SPEC.md) |
| [setup-declaration](setup-declaration/README.md)   | Trusted `.sec-review/setup.yml` format                       | Reviewed repositories, GitHub Integration, and Execution Worker | [v1](setup-declaration/v1/SPEC.md)                                                                                                                                                                   |

## Rules For Every Contract

A contract is named for what it covers. If one component owns every shape in it, name it after that component — `review-runs-api` is Review Runs's own shapes. If the shapes span several parties, name it after where they meet — `execution-api` is provided by Execution Gateway; Review Runs submits execution requests and queries their status, and GitHub Integration uses the results to publish comments, suggestions, or draft PRs to GitHub.

Do not name a contract solely after one consumer: adding another consumer should not make the name misleading. Do not reuse a name that another contract already uses for a different meaning.

The specification, its schemas, its fixtures, and the fixture manifest change together.

Schemas own the structural shape: required fields, JSON types, enums, tagged variants, and additional-field policy. They do not replace domain code. Cross-field rules stay with the workflow that makes the decision, and side-effect policy such as safe repository paths, platform permissions, publishing eligibility, and retry behavior stays with the consumer.

Fixtures are part of contract validation. The manifest records which valid fixtures each schema must accept and which invalid fixtures it must reject, so every implementation exercises the same structural boundary.

### Binary And Content-Addressed Artifacts

For an archive, compressed stream, or other content-addressed artifact, the specification must separate producer obligations from consumer obligations. State which representation producers must emit, which alternate representations consumers may accept, and which inputs every consumer must reject. Library defaults are implementation details, not contract rules.

An artifact reference must bind the declared media type, compressed-byte size, digest, and canonical storage location when the contract defines one. Consumers verify that reference shape and location first, then compressed size and digest, before decompression or semantic parsing. A trusted object store or matching digest does not replace validation of archive paths, entry types, metadata, limits, or internal manifests.

Each archive contract maintains a shared corpus of actual archive files. It should cover valid interoperability cases, malformed structure, representation extensions, duplicate or ambiguous names, links and special entries, and concrete resource limits. Every consumer runs the same corpus. Every producer also has focused tests proving that it emits valid corpus-equivalent output and rejects inputs it cannot encode without leaving the canonical format.

Stress fixtures remain real artifacts, but their readable manifest may record aggregate facts such as `entryCount` instead of expanding thousands of repetitive entries. The fixture bytes and validator result remain the oracle.

Tests read fixtures through their package-local helper instead of hard-coding paths:

- Python: `tests.contract_fixtures`
- TypeScript: `test/contract-fixtures.ts`

Each contract README records who owns which side of its boundary and what callers may rely on.

## Derived Artifacts

API TypeScript types, some JSON Schemas, and parameter lists are generated from contracts. The owning contract or format layer keeps its generation and validation tools in `tools/`. Those tools remain responsible for checking outputs even when the files are written into another package. `generated-artifacts.json` lists each output and its location.

Name a stable package entry point for the responsibility callers consume, even when a generator maintains it (`execution-api-version.ts`, for example). Raw mechanical projections may carry `generated` in the filename when that helps distinguish files that should not accumulate hand-written behavior (`contract-types-generated.ts`, for example). The filename is not the enforcement boundary: every committed generated artifact must identify itself in its header, appear in the contract manifest, and be covered by the freshness and CI checks below.

Each tool provides `generate` to regenerate its outputs and `check` to compare them with committed files. Tests compare the output manifest with the generator declarations and verify that CI change filters cover each listed output. Add new outputs to that manifest so the existing checks can verify coverage.

The API contract tools share the development-only [TypeScript renderer](codegen/README.md). The tools for each contract install it as an explicit local package dependency and retains ownership of its contract-specific projections and checks.

## Change Checklist

For any contract change:

- update the specification for the affected version;
- update its schemas;
- update or add its fixtures and manifest entries;
- regenerate any derived artifact (such as the Review Runs's committed `v1` schemas and generated types) with the owning contract or layer's local tool, then run its `check` command;
- make both the Python and TypeScript tests validate the same files.
- for binary artifacts, run producer tests, every consumer's shared-corpus tests, and at least one end-to-end reference-to-bytes validation path.
