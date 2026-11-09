"""Fixtures and policies that apply across the agents test suite."""

import os
from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(scope="session", autouse=True)
def _isolate_git_environment(
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[None]:
    """Keep fixture repositories independent of developer Git settings.

    Apply before other test fixtures create repositories. Tests can still set
    repository-local configuration or explicitly override the environment.
    """
    config = tmp_path_factory.mktemp("git-config") / "config"
    # Disabling global config alone leaves Git's default XDG attributes file active.
    config.write_text(f'[core]\n\tattributesFile = "{os.devnull}"\n', encoding="utf-8")
    with pytest.MonkeyPatch.context() as patch:
        for key in tuple(os.environ):
            if key.startswith("GIT_"):
                patch.delenv(key)
        patch.setenv("GIT_CONFIG_NOSYSTEM", "1")
        patch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
        patch.setenv("GIT_CONFIG_GLOBAL", str(config))
        patch.setenv("GIT_ATTR_NOSYSTEM", "1")
        yield


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
