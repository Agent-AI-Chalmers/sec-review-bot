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
```

Not every family uses every kind of asset. A contract whose rules are decision logic rather than a structural shape carries a `corpus/` instead of `schemas/` and `fixtures/`, and enforces the format in code. See
[setup-declaration](setup-declaration/README.md) for that shape.

A family may also hold documents that apply to every version, such as a transport reference.

## Families

- [integration-contract](integration-contract/README.md): the public integration point
  between the Runner and its callers. Current version: [v6](integration-contract/v6/CONTRACT.md).
- [execution-contract](execution-contract/README.md): the private Temporal dispatch boundary between Execution Gateway and Execution Worker. Current version: v1.
- [control-plane-api](control-plane-api/README.md): the shapes Control Plane exchanges
  with its callers. Current version:
  [v1](control-plane-api/README.md).
- [memory-catalog-api](memory-catalog-api/README.md): the HTTP boundary between the
  Memory Catalog Server and execution workers. Current version: v1.
- [setup-declaration](setup-declaration/README.md): the `.sec-review/setup.yml` format a
  repository uses to prepare its review sandbox. Current version:
  [v1](setup-declaration/v1/SPEC.md).

## Rules For Every Family

A family is named for what it covers. If one component owns every shape in it, name it after that component — `control-plane-api` is Control Plane's own shapes. If the shapes span several parties, name it after where they meet — `integration-contract` spans the Runner, its callers, and a downstream publisher.

Do not name a family after one of its consumers: consumers change, the provider does not. And do not reuse a word that another family already uses for a different meaning.

The specification, its schemas, its fixtures, and the fixture manifest change together.

Schemas own the structural shape: required fields, JSON types, enums, tagged variants, and additional-field policy. They do not replace domain code. Cross-field rules stay with the workflow that makes the decision, and side-effect policy such as safe repository paths, platform permissions, publishing eligibility, and retry behavior stays with the consumer.

Fixtures are part of contract validation. The manifest records which valid fixtures each schema must accept and which invalid fixtures it must reject, so every implementation exercises the same structural boundary.

Tests read fixtures through their package-local helper instead of hard-coding paths:

- Python: `tests.contract_fixtures`
- TypeScript: `test/contract-fixtures.ts`

Each family README records who owns which side of its boundary and what callers may rely on.

## Derived Artifacts

Some artifacts are generated from a hand-written contract rather than maintained by hand — a TypeScript projection of an API, committed JSON Schemas, a generated parameter list. Each family owns the tool that renders and checks its projections, under `<family>/tools/`, so the tool that reads a contract lives beside it and where its outputs land (which may be another package) does not change who owns the check. A family's `tools/generated-artifacts.json` lists what it derives and where it lands.

Name a stable package entry point for the responsibility callers consume, even when a generator maintains it (`contract-version.ts`, for example). Raw mechanical projections may carry `generated` in the filename when that helps distinguish files that should not accumulate hand-written behavior (`contract-types-generated.ts`, for example). The filename is not the enforcement boundary: every committed generated artifact must identify itself in its header, appear in the family manifest, and be covered by the freshness and CI checks below.

Each tool provides `pnpm --dir contracts/<family>/tools run generate` to render every artifact and `pnpm --dir contracts/<family>/tools run check` to prove the committed copies match. A family's test asserts the manifest matches the generators' own declared outputs and that the CI change filter triggers on every listed artifact, so a new projection is covered by being listed, not by remembering to wire up a check.

## Change Checklist

For any contract change:

- update the specification for the affected version;
- update its schemas;
- update or add its fixtures and manifest entries;
- regenerate any derived artifact (such as the Control Plane's committed `v1` schemas and generated types) with its family's tool: `pnpm --dir contracts/<family>/tools run generate`, then confirm with `... run check`;
- make both the Python and TypeScript tests validate the same files.
