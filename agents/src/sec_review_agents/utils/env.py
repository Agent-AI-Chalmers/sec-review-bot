import os
import re
from pathlib import Path
from typing import overload

"""Environment value helpers used as the configuration semantics layer.

This module can bootstrap the agents-side `.env` file, then interpret values
with project-specific rules:

- strict bool, integer, and float parsing with defaults only when unset
- selected path values from `.env` are resolved relative to the `.env` file
  itself, not the process current working directory
"""

_AGENTS_ENV_BOOTSTRAPPED = False
# These `.env` path settings use config-file-relative semantics so they stay
# stable across different start commands and working directories.
_DOTENV_RELATIVE_PATH_KEYS = {"MODEL_PROVIDERS_CONFIG_TOML"}
_DECIMAL_INTEGER = re.compile(r"[+-]?[0-9]+")
_TRUE_ENV_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_ENV_VALUES = frozenset({"0", "false", "no", "off"})


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


def bool_env(name: str, default: bool = False) -> bool:
    """Read a boolean environment variable, defaulting only when it is unset."""
    value = os.environ.get(name)
    if value is None:
        return default

    normalized = value.strip().lower()
    if normalized in _TRUE_ENV_VALUES:
        return True
    if normalized in _FALSE_ENV_VALUES:
        return False
    raise ValueError(f"{name} must be one of: 1, true, yes, on, 0, false, no, off.")


@overload
def int_env(
    name: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int: ...


@overload
def int_env(
    name: str,
    default: None = None,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int | None: ...


def int_env(
    name: str,
    default: int | None = None,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int | None:
    """Read a decimal integer environment variable and validate its range."""
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    value_text = raw_value.strip()
    if _DECIMAL_INTEGER.fullmatch(value_text) is None:
        raise ValueError(f"{name} must be a decimal integer.")
    value = int(value_text)
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be at most {maximum}.")
    return value


def float_env(
    name: str,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    """Read a finite float environment variable and validate its range."""
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    try:
        value = float(raw_value.strip())
    except ValueError as error:
        raise ValueError(f"{name} must be a number.") from error
    if not (float("-inf") < value < float("inf")):
        raise ValueError(f"{name} must be finite.")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be at most {maximum}.")
    return value
