# External Tool Tests

This directory owns tests for the Joern and Playwright CLI integrations across all execution levels.

- Ordinary tests cover environment gates, prompt selection, case schemas, materialization, and oracles.
- Tests marked `integration` exercise the installed CLI in the Docker sandbox without an LLM.
- Tests marked `llm` run the gated product-agent discovery and comparison cases under `cases/`.

Markers describe execution requirements; environment gates still decide whether Docker images and real LLM configuration are available. Run the deterministic external-tool suite with:

```bash
uv run python -m pytest tests/external_tools -m "not llm"
```

Run only no-model capability tests with:

```bash
uv run python -m pytest tests/external_tools -m "integration and not llm"
```

See [`cases/README.md`](cases/README.md) for the gated LLM commands and fixture design.
