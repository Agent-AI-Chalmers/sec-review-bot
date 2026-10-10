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
      schemas/*.json   machine-checkable shapes
      fixtures/*.json  executable examples, plus the manifest that pairs them
```

A family may also hold documents that apply to every version, such as a transport reference.

## Families

- [integration-contract](integration-contract/README.md): the public integration point
  between the Runner and its callers. Current version: [v5](integration-contract/v5/CONTRACT.md).
- [control-plane-api](control-plane-api/README.md): the shapes Control Plane exchanges
  with its callers. Current version:
  [v1](control-plane-api/v1/observed-run.schema.json).

## Rules For Every Family

The specification, its schemas, its fixtures, and the fixture manifest change together.

Schemas own the structural shape: required fields, JSON types, enums, tagged variants, and additional-field policy. They do not replace domain code. Cross-field rules stay with the workflow that makes the decision, and side-effect policy such as safe repository paths, platform permissions, publishing eligibility, and retry behavior stays with the consumer.

Fixtures are part of contract validation. The manifest records which valid fixtures each schema must accept and which invalid fixtures it must reject, so every implementation exercises the same structural boundary.

Tests read fixtures through their package-local helper instead of hard-coding paths:

- Python: `tests.contract_fixtures`
- TypeScript: `test/contract-fixtures.ts`

Each family README records who owns which side of its boundary and what callers may rely on.

## Change Checklist

For any contract change:

- update the specification for the affected version;
- update its schemas;
- update or add its fixtures and manifest entries;
- make both the Python and TypeScript tests validate the same files;
- keep [scripts/check_contracts.sh](../scripts/check_contracts.sh) aligned with the
  validation surface, and run it before publishing the change.
