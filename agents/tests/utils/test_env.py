import os
from pathlib import Path
from unittest.mock import patch

from sec_review_agents.utils.env import load_dotenv_file


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
