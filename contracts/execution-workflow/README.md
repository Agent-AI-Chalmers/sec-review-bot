# Execution Workflow

Language: English | [中文](README.zh.md)

This contract defines the input accepted by the Temporal Execution Workflow shared by Execution Gateway and Execution Worker.

Use these files:

- [v1/CONTRACT.md](v1/CONTRACT.md): the workflow type and field semantics.
- [v1/execution-workflow-input.schema.json](v1/execution-workflow-input.schema.json): the executable structural boundary.
- [v1/fixtures](v1/fixtures): shared valid and invalid inputs executed by both implementations.

## Boundary

Execution Gateway produces this value when it starts `execution-workflow`. Execution Worker validates the same value before preparing and dispatching the selected review workflow. The nested `input` remains governed by the selected Execution API workflow schema; this family owns only the Temporal handoff envelope.

## Enforcement

Execution Gateway validates with Ajv. Execution Worker keeps the raw Temporal mapping during workflow deserialization, validates it with `jsonschema` at the start of input preparation, then converts it to `ExecutionWorkflowInput`. Preparation uses the worker's configured timeout rather than an unvalidated request timeout.

Both implementations test every fixture listed in the manifest, which must cover every JSON fixture in the directory. New cases must be accepted or rejected consistently by both implementations.
