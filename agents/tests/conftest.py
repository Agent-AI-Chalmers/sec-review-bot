"""Fixtures and policies that apply across the agents test suite."""

from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def _missing_model_providers_config(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Return a deliberately absent config path shared by ordinary tests."""
    return tmp_path_factory.getbasetemp() / "missing-model-providers.toml"


@pytest.fixture(autouse=True)
def _isolate_model_provider_config(
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
    _missing_model_providers_config: Path,
) -> None:
    """Prevent ordinary tests from inheriting a developer's real LLM config.

    Local model configuration can hide a missing model mock and make a test pass
    locally while failing in CI. Tests marked ``llm`` are the explicit exception:
    their probe-specific opt-in controls access to real model deployments.
    """
    if request.node.get_closest_marker("llm") is not None:
        return

    monkeypatch.setenv(
        "MODEL_PROVIDERS_CONFIG_TOML",
        str(_missing_model_providers_config),
    )
