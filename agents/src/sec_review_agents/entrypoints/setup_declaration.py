"""Parse and validate the setup declaration (`.sec-review/setup.yml`).

The declaration is executable content pulled from the repository's default
branch. It is therefore parsed strictly against an allow-list: anything the
schema does not explicitly permit is rejected, never silently ignored.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_STEP_TIMEOUT_SECONDS = 300
MAX_STEP_TIMEOUT_ENV = "SEC_REVIEW_SETUP_STEP_MAX_SECONDS"
DEFAULT_MAX_STEP_TIMEOUT_SECONDS = 600

_ALLOWED_STEP_KEYS = frozenset({"run", "working-directory", "env", "timeout_seconds"})

# Environment variable names are emitted as `export KEY=...` in a shell command.
# Restrict them to portable shell identifiers so a declaration cannot smuggle
# shell syntax through a name (cheap hardening; declarations are trusted, but a
# malformed name is a clear authoring error worth rejecting at parse time).
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class SetupDeclarationError(ValueError):
    """Raised when a setup declaration is malformed or not allowed."""


@dataclass(frozen=True)
class SetupDeclarationStep:
    run: str
    working_directory: str | None
    env: dict[str, str] = field(default_factory=dict)
    timeout_seconds: int = DEFAULT_STEP_TIMEOUT_SECONDS


@dataclass(frozen=True)
class SetupDeclaration:
    steps: tuple[SetupDeclarationStep, ...]


def max_step_timeout_seconds() -> int:
    raw = os.environ.get(MAX_STEP_TIMEOUT_ENV)
    if raw is None or not raw.strip():
        return DEFAULT_MAX_STEP_TIMEOUT_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_STEP_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_MAX_STEP_TIMEOUT_SECONDS


def parse_setup_declaration(content: str) -> SetupDeclaration:
    """Parse declaration content. Raises SetupDeclarationError on anything unexpected."""
    try:
        parsed = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise SetupDeclarationError(
            f"Setup declaration is not valid YAML: {error}"
        ) from error

    if not isinstance(parsed, dict):
        raise SetupDeclarationError(
            "Setup declaration must be a mapping at the top level."
        )

    unknown_top_level = sorted(set(parsed) - {"setup"})
    if unknown_top_level:
        raise SetupDeclarationError(
            "Setup declaration has unsupported top-level key(s): "
            + ", ".join(str(key) for key in unknown_top_level)
        )

    raw_steps = parsed.get("setup")
    if raw_steps is None:
        raise SetupDeclarationError(
            "Setup declaration is missing the required 'setup' key."
        )
    if not isinstance(raw_steps, list):
        raise SetupDeclarationError(
            "Setup declaration 'setup' must be a list of steps."
        )

    max_timeout = max_step_timeout_seconds()
    steps = tuple(
        _parse_step(raw_step, index, max_timeout)
        for index, raw_step in enumerate(raw_steps)
    )
    return SetupDeclaration(steps=steps)


def _parse_step(raw_step: Any, index: int, max_timeout: int) -> SetupDeclarationStep:
    label = f"setup[{index}]"
    if not isinstance(raw_step, dict):
        raise SetupDeclarationError(f"{label} must be a mapping.")

    unknown = sorted(set(raw_step) - _ALLOWED_STEP_KEYS)
    if unknown:
        raise SetupDeclarationError(
            f"{label} has unsupported key(s): {', '.join(str(key) for key in unknown)}"
        )

    run = raw_step.get("run")
    if run is None:
        raise SetupDeclarationError(f"{label} is missing the required 'run' key.")
    if not isinstance(run, str) or not run.strip():
        raise SetupDeclarationError(f"{label}.run must be a non-empty string.")

    working_directory = _parse_working_directory(
        raw_step.get("working-directory"), label
    )
    env = _parse_env(raw_step.get("env"), label)
    timeout_seconds = _parse_timeout(
        raw_step.get("timeout_seconds"), label, max_timeout
    )

    return SetupDeclarationStep(
        run=run,
        working_directory=working_directory,
        env=env,
        timeout_seconds=timeout_seconds,
    )


def _parse_working_directory(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise SetupDeclarationError(
            f"{label}.working-directory must be a non-empty string."
        )
    normalized = value.strip()
    if normalized.startswith("/") or normalized.split("/")[0] == "..":
        raise SetupDeclarationError(
            f"{label}.working-directory must be relative to the repository root: {value!r}"
        )
    if ".." in Path(normalized).parts:
        raise SetupDeclarationError(
            f"{label}.working-directory must not escape the repository root: {value!r}"
        )
    return normalized


def _parse_env(value: Any, label: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise SetupDeclarationError(f"{label}.env must be a mapping of strings.")
    env: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise SetupDeclarationError(
                f"{label}.env must map string keys to string values."
            )
        if not _ENV_NAME_RE.match(key):
            raise SetupDeclarationError(
                f"{label}.env has an invalid variable name: {key!r}"
            )
        env[key] = item
    return env


def _parse_timeout(value: Any, label: str, max_timeout: int) -> int:
    if value is None:
        return DEFAULT_STEP_TIMEOUT_SECONDS
    if isinstance(value, bool) or not isinstance(value, int):
        raise SetupDeclarationError(f"{label}.timeout_seconds must be an integer.")
    if value <= 0:
        raise SetupDeclarationError(f"{label}.timeout_seconds must be positive.")
    return min(value, max_timeout)


__all__ = [
    "DEFAULT_MAX_STEP_TIMEOUT_SECONDS",
    "DEFAULT_STEP_TIMEOUT_SECONDS",
    "MAX_STEP_TIMEOUT_ENV",
    "SetupDeclaration",
    "SetupDeclarationError",
    "SetupDeclarationStep",
    "max_step_timeout_seconds",
    "parse_setup_declaration",
]
