# Memory Tests

This directory owns memory store, state, extraction, maintenance, mounting, scheduling, CLI, workflow registration, and real-LLM behavior tests.

## Test Layers

Deterministic tests cover storage and state transitions, transcript staging, extraction and maintenance orchestration with mocked agents, backend mounting, schedules, CLI behavior, and workflow registration.

The `test_llm_*.py` files are focused real-model probes:

- `test_llm_middleware.py` checks that an agent uses the memory index to read a relevant topic.
- `test_llm_extraction.py` checks transcript-to-observation extraction.
- `test_llm_maintenance.py` checks memory reorganization and publication.
- `test_llm_lifecycle.py` checks extraction followed by maintenance.

These probes have distinct inputs and lifecycle oracles, so they remain explicit tests rather than being forced into a shared `case.json` schema.

## Running Tests

Run deterministic memory tests from `agents/`:

```bash
uv run python -m pytest tests/memory -m "not llm"
```

Real-model probes are disabled by default. Enable one probe with its corresponding environment variable and `LLM_TEST_DEPLOYMENT`; the commands are listed in [`tests/LLM_PROBES.md`](../LLM_PROBES.md).
