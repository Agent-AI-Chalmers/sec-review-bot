# Tests

Tests are organized by the production behavior or domain they protect. Test mechanism, runtime cost, and use of a real model are execution attributes, not ownership boundaries.

## Running Tests

Run tests from `agents/` so the local project and environment are explicit:

```bash
uv run python -m pytest
```

During development, prefer the narrowest relevant file or directory. Marker selection can further control execution:

```bash
uv run python -m pytest tests/workflows/issue -q
uv run python -m pytest -m integration -q
uv run python -m pytest -m llm -q
```

Real-model tests remain skipped unless their probe-specific environment variable is enabled. Selecting the `llm` marker alone does not opt into external model calls.

## Test Guides

- [Optional probes](PROBES.md): complete opt-in inventory, model setup, external dependencies, and CI coverage limits.
- [Memory](memory/README.md): extraction, learning maintenance, reorganization, and memory middleware.
- [Bundled skills](skills/README.md): case inputs, behavioral oracles, and selection modes.
- [MCP](mcp/README.md): capability, discovery, and CodeGraph comparison probes.
- [External tools](external_tools/README.md): Joern and Playwright CLI capability and comparison cases.

## Test Ownership

Put a test next to the domain whose contract would be wrong if the test failed:

- Runtime behavior belongs under `tests/runtime/`.
- Review-stage behavior belongs under `tests/review_stages/`.
- Workflow behavior belongs under `tests/workflows/<workflow>/`.
- Tests of the production `sec_review_agents.llm` package belong under `tests/llm/`.

A test does not belong under `tests/llm/` merely because it uses a language model. For example, a real-model issue analyzer probe still belongs to the issue workflow, and a summarization probe belongs to runtime. This keeps model-backed and deterministic tests of the same contract close together.

Use `integration` and `llm` markers to describe how a test executes. Do not use those markers to decide its directory.

## Case Corpora

Data-driven cases belong to the domain that interprets their inputs and oracle. Use this shape when a domain has enough cases to justify a corpus:

```text
tests/<owner>/cases/
|-- models.py
|-- loader.py
|-- runner.py
`-- <case-id>/
    |-- case.json
    `-- workspace/
```

`case.json` contains the case input, expectations, and stable oracle. `models.py` defines that data contract, `loader.py` validates and discovers cases, and `runner.py` executes them. Keep probe-specific assertions in the owning test rather than expanding the shared oracle for one experiment.

The `workspace/` directory is an input repository, not test implementation code. Type checkers exclude case workspaces for that reason. Do not add tests that merely assert fixture files exist or restate loader validation; exercise the corpus through the consumer that gives it meaning.

## Shared Test Infrastructure

Keep a helper local when it has one owning test or domain. A top-level test module is appropriate only when multiple independent domains share a narrow, stable responsibility. Current examples include `tests/llm_probe.py`, `tests/contract_fixtures.py`, `tests/input_bundle.py`, and `tests/temporal_test_utils.py`.

Name shared modules after the capability they provide. Avoid generic `helpers`, `support`, or `utils` packages that erase ownership and accumulate unrelated behavior. Shared infrastructure should reduce repeated setup without becoming a framework around the tests.
