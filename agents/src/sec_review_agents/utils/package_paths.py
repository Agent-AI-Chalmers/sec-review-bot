from pathlib import Path


def default_agents_root_path() -> Path:
    """Return the fixed agents project root based on this package location."""
    return Path(__file__).resolve().parents[3]


def default_model_providers_config_path() -> Path:
    return (default_agents_root_path() / "config" / "model-providers.toml").resolve()


def default_agents_env_path() -> Path:
    return (default_agents_root_path() / ".env").resolve()
