# Memory Tests

This directory owns memory execution cores, artifact handling, mounting, scheduling, CLI, workflow registration, and real-LLM behavior tests.

## Test Layers

Deterministic tests cover trajectory staging, extraction and maintenance execution with mocked agents, Catalog artifact materialization, backend mounting, schedules, CLI behavior, and workflow registration.

The `test_llm_*.py` files are focused real-model probes:

- `test_llm_middleware.py` checks that an agent uses the memory index to read a relevant topic.
- `test_llm_extraction.py` checks trajectory-to-observation extraction.
- `test_llm_maintenance.py` checks learning from a new observation and pure reorganization separately, including preservation of existing lessons and routing to maintained topics.

Each probe has its own inputs and behavior oracle, so they stay as separate explicit tests and do not share a `case.json` schema.

## Running Tests

Run deterministic memory tests from `agents/`:

```bash
uv run python -m pytest tests/memory -m "not llm"
```

## Real-Model Probes

Model setup and the complete optional-test inventory are in [PROBES.md](../PROBES.md). These probes require `LLM_TEST_DEPLOYMENT`:

```bash
RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION=1 LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/memory/test_llm_middleware.py -q -s

RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1 LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/memory/test_llm_extraction.py -q -s

RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION=1 LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/memory/test_llm_maintenance.py -q -s
```

Maintenance runs learning and pure reorganization separately, checking retained lessons and index routing without prescribing topic filenames. Select `-k learning` or `-k reorganization` to isolate one path.
