import os
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.utils.env import bool_env, float_env, int_env, load_dotenv_file


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_bool_env_accepts_documented_true_values(monkeypatch, value: str) -> None:
    monkeypatch.setenv("TEST_BOOL", value)

    assert bool_env("TEST_BOOL") is True


@pytest.mark.parametrize("value", ["0", "false", "NO", " off "])
def test_bool_env_accepts_documented_false_values(monkeypatch, value: str) -> None:
    monkeypatch.setenv("TEST_BOOL", value)

    assert bool_env("TEST_BOOL", True) is False


@pytest.mark.parametrize("value", ["", "flase", "2"])
def test_bool_env_rejects_explicit_invalid_values(monkeypatch, value: str) -> None:
    monkeypatch.setenv("TEST_BOOL", value)

    with pytest.raises(ValueError, match="TEST_BOOL must be one of"):
        bool_env("TEST_BOOL", True)


def test_bool_env_uses_default_only_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("TEST_BOOL", raising=False)

    assert bool_env("TEST_BOOL", True) is True


@pytest.mark.parametrize("value", ["", "10junk", "1.5", "1_000"])
def test_int_env_rejects_non_decimal_values(monkeypatch, value: str) -> None:
    monkeypatch.setenv("TEST_INT", value)

    with pytest.raises(ValueError, match="TEST_INT must be a decimal integer"):
        int_env("TEST_INT", 7)


def test_int_env_validates_configured_range(monkeypatch) -> None:
    monkeypatch.setenv("TEST_INT", "0")

    with pytest.raises(ValueError, match="TEST_INT must be at least 1"):
        int_env("TEST_INT", 7, minimum=1)


def test_int_env_uses_default_only_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("TEST_INT", raising=False)

    assert int_env("TEST_INT", 7, minimum=1) == 7


@pytest.mark.parametrize("value", ["", "many"])
def test_float_env_rejects_non_numeric_values(monkeypatch, value: str) -> None:
    monkeypatch.setenv("TEST_FLOAT", value)

    with pytest.raises(ValueError, match="TEST_FLOAT must be a number"):
        float_env("TEST_FLOAT", 1.5)


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_float_env_rejects_non_finite_values(monkeypatch, value: str) -> None:
    monkeypatch.setenv("TEST_FLOAT", value)

    with pytest.raises(ValueError, match="TEST_FLOAT must be finite"):
        float_env("TEST_FLOAT", 1.5)


def test_float_env_validates_inclusive_range(monkeypatch) -> None:
    monkeypatch.setenv("TEST_FLOAT", "0")
    assert float_env("TEST_FLOAT", 1.5, minimum=0.0, maximum=2.0) == 0.0

    monkeypatch.setenv("TEST_FLOAT", "2.1")
    with pytest.raises(ValueError, match="TEST_FLOAT must be at most 2.0"):
        float_env("TEST_FLOAT", 1.5, minimum=0.0, maximum=2.0)


def test_float_env_uses_default_only_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("TEST_FLOAT", raising=False)

    assert float_env("TEST_FLOAT", 1.5, minimum=0.0) == 1.5


def test_model_providers_config_path_from_dotenv_is_relative_to_dotenv_dir(
    tmp_path: Path,
) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        'MODEL_PROVIDERS_CONFIG_TOML="config/model-providers.toml"\n',
        encoding="utf-8",
    )

    with patch.dict(os.environ, {}, clear=True):
        load_dotenv_file(dotenv_path)

        assert os.environ["MODEL_PROVIDERS_CONFIG_TOML"] == str(
            tmp_path / "config" / "model-providers.toml"
        )


def test_dotenv_does_not_override_existing_model_providers_config_path(
    tmp_path: Path,
) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        'MODEL_PROVIDERS_CONFIG_TOML="config/model-providers.toml"\n',
        encoding="utf-8",
    )

    with patch.dict(
        os.environ,
        {"MODEL_PROVIDERS_CONFIG_TOML": "/already/configured.toml"},
        clear=True,
    ):
        load_dotenv_file(dotenv_path)

        assert os.environ["MODEL_PROVIDERS_CONFIG_TOML"] == "/already/configured.toml"
