import os
from pathlib import Path

"""Environment value helpers used as the configuration semantics layer.

This module can bootstrap the agents-side `.env` file, then interpret values
with project-specific rules:

- tolerant bool parsing with explicit defaults
- tolerant int parsing with explicit defaults
- selected path values from `.env` are resolved relative to the `.env` file
  itself, not the process current working directory
"""

_AGENTS_ENV_BOOTSTRAPPED = False
# These `.env` path settings use config-file-relative semantics so they stay
# stable across different start commands and working directories.
_DOTENV_RELATIVE_PATH_KEYS = {"AGENT_MEMORY_DIR", "MODEL_PROVIDERS_CONFIG_TOML"}


def _parse_env_assignment(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None

    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].strip()

    if "=" not in stripped:
        return None

    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None

    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]

    return key, value


def load_dotenv_file(dotenv_path: Path, *, override: bool = False) -> None:
    if not dotenv_path.exists() or not dotenv_path.is_file():
        return

    dotenv_dir = dotenv_path.resolve().parent
    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        assignment = _parse_env_assignment(raw_line)
        if assignment is None:
            continue

        key, value = assignment
        if not override and key in os.environ:
            continue
        if key in _DOTENV_RELATIVE_PATH_KEYS and value:
            path_value = Path(value).expanduser()
            if not path_value.is_absolute():
                value = str((dotenv_dir / path_value).resolve())
        os.environ[key] = value


def bootstrap_agents_env() -> Path:
    from sec_review_agents.utils.package_paths import default_agents_env_path

    global _AGENTS_ENV_BOOTSTRAPPED

    dotenv_path = default_agents_env_path()
    if _AGENTS_ENV_BOOTSTRAPPED:
        return dotenv_path

    load_dotenv_file(dotenv_path)
    _AGENTS_ENV_BOOTSTRAPPED = True
    return dotenv_path


def env_value(name: str) -> str | None:
    """Return a stripped env value, treating empty strings as unset."""
    value = os.environ.get(name)
    if value and value.strip():
        return value.strip()
    return None


def parse_bool_env(value: str | None, default: bool = False) -> bool:
    """Parse a bool-like string with graceful fallback to default.

    Accepted true values: 1/true/yes/on
    Accepted false values: 0/false/no/off
    Any other input uses default.
    """

    if value is None:
        return default

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def parse_int_env(value: str | None, default: int | None = None) -> int | None:
    """Parse an integer value with graceful fallback to default.

    Invalid or non-integer input is treated as unset and returns default.
    """

    if value is None:
        return default

    try:
        return int(value)
    except TypeError, ValueError:
        return default
