"""Parse and validate the trusted setup declaration (`.sec-review/setup.yml`).

The declaration is executable content pulled from the repository's default
branch. It is therefore parsed strictly against an allow-list: anything the
schema does not explicitly permit is rejected, never silently ignored.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_STEP_TIMEOUT_SECONDS = 300
MAX_STEP_TIMEOUT_ENV = "SEC_REVIEW_SETUP_STEP_MAX_SECONDS"
DEFAULT_MAX_STEP_TIMEOUT_SECONDS = 600

_ALLOWED_STEP_KEYS = frozenset({"run", "working-directory", "env", "timeout_seconds"})


class TrustedSetupError(ValueError):
    """Raised when a trusted setup declaration is malformed or not allowed."""


@dataclass(frozen=True)
class TrustedSetupStep:
    run: str
    working_directory: str | None
    env: dict[str, str] = field(default_factory=dict)
    timeout_seconds: int = DEFAULT_STEP_TIMEOUT_SECONDS


@dataclass(frozen=True)
class TrustedSetup:
    steps: tuple[TrustedSetupStep, ...]


def max_step_timeout_seconds() -> int:
    raw = os.environ.get(MAX_STEP_TIMEOUT_ENV)
    if raw is None or not raw.strip():
        return DEFAULT_MAX_STEP_TIMEOUT_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_STEP_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_MAX_STEP_TIMEOUT_SECONDS


def parse_trusted_setup(content: str) -> TrustedSetup:
    """Parse declaration content. Raises TrustedSetupError on anything unexpected."""
    try:
        parsed = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise TrustedSetupError(f"Trusted setup is not valid YAML: {error}") from error

    if not isinstance(parsed, dict):
        raise TrustedSetupError("Trusted setup must be a mapping at the top level.")

    unknown_top_level = sorted(set(parsed) - {"setup"})
    if unknown_top_level:
        raise TrustedSetupError(
            "Trusted setup has unsupported top-level key(s): "
            + ", ".join(str(key) for key in unknown_top_level)
        )

    raw_steps = parsed.get("setup")
    if raw_steps is None:
        raise TrustedSetupError("Trusted setup is missing the required 'setup' key.")
    if not isinstance(raw_steps, list):
        raise TrustedSetupError("Trusted setup 'setup' must be a list of steps.")

    max_timeout = max_step_timeout_seconds()
    steps = tuple(
        _parse_step(raw_step, index, max_timeout)
        for index, raw_step in enumerate(raw_steps)
    )
    return TrustedSetup(steps=steps)


def _parse_step(raw_step: Any, index: int, max_timeout: int) -> TrustedSetupStep:
    label = f"setup[{index}]"
    if not isinstance(raw_step, dict):
        raise TrustedSetupError(f"{label} must be a mapping.")

    unknown = sorted(set(raw_step) - _ALLOWED_STEP_KEYS)
    if unknown:
        raise TrustedSetupError(
            f"{label} has unsupported key(s): {', '.join(str(key) for key in unknown)}"
        )

    run = raw_step.get("run")
    if run is None:
        raise TrustedSetupError(f"{label} is missing the required 'run' key.")
    if not isinstance(run, str) or not run.strip():
        raise TrustedSetupError(f"{label}.run must be a non-empty string.")

    working_directory = _parse_working_directory(
        raw_step.get("working-directory"), label
    )
    env = _parse_env(raw_step.get("env"), label)
    timeout_seconds = _parse_timeout(
        raw_step.get("timeout_seconds"), label, max_timeout
    )

    return TrustedSetupStep(
        run=run,
        working_directory=working_directory,
        env=env,
        timeout_seconds=timeout_seconds,
    )


def _parse_working_directory(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise TrustedSetupError(
            f"{label}.working-directory must be a non-empty string."
        )
    normalized = value.strip()
    if normalized.startswith("/") or normalized.split("/")[0] == "..":
        raise TrustedSetupError(
            f"{label}.working-directory must be relative to the repository root: {value!r}"
        )
    if ".." in Path(normalized).parts:
        raise TrustedSetupError(
            f"{label}.working-directory must not escape the repository root: {value!r}"
        )
    return normalized


def _parse_env(value: Any, label: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TrustedSetupError(f"{label}.env must be a mapping of strings.")
    env: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise TrustedSetupError(
                f"{label}.env must map string keys to string values."
            )
        env[key] = item
    return env


def _parse_timeout(value: Any, label: str, max_timeout: int) -> int:
    if value is None:
        return DEFAULT_STEP_TIMEOUT_SECONDS
    if isinstance(value, bool) or not isinstance(value, int):
        raise TrustedSetupError(f"{label}.timeout_seconds must be an integer.")
    if value <= 0:
        raise TrustedSetupError(f"{label}.timeout_seconds must be positive.")
    return min(value, max_timeout)


__all__ = [
    "DEFAULT_MAX_STEP_TIMEOUT_SECONDS",
    "DEFAULT_STEP_TIMEOUT_SECONDS",
    "MAX_STEP_TIMEOUT_ENV",
    "TrustedSetup",
    "TrustedSetupError",
    "TrustedSetupStep",
    "max_step_timeout_seconds",
    "parse_trusted_setup",
]
