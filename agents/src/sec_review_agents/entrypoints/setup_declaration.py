"""Parse and validate the setup declaration (`.sec-review/setup.yml`).

The declaration is executable content pulled from the repository's default
branch. It is therefore parsed strictly against an allow-list: anything the
schema does not explicitly permit is rejected, never silently ignored.
"""

import os
import re
from dataclasses import dataclass, field
from typing import Any

import yaml
import yamlcore  # type: ignore[import-untyped]

DEFAULT_STEP_TIMEOUT_SECONDS = 300
MAX_STEP_TIMEOUT_ENV = "SEC_REVIEW_SETUP_STEP_MAX_SECONDS"
DEFAULT_MAX_STEP_TIMEOUT_SECONDS = 600

# Upper bound on the declaration text. It travels inline in the workflow input,
# so an unbounded default-branch file would grow every submission; the
# integration enforces the same limit at the producer (see
# `MAX_SETUP_DECLARATION_BYTES` in `apps/github-integration`), and the contract
# schema carries it as a third check.
MAX_SETUP_DECLARATION_BYTES = 65536

_ALLOWED_STEP_KEYS = frozenset({"run", "working-directory", "env", "timeout_seconds"})

# Environment variable names are emitted as `export KEY=...` in a shell command.
# Restrict them to portable shell identifiers so a declaration cannot smuggle
# shell syntax through a name (cheap hardening; declarations are trusted, but a
# malformed name is a clear authoring error worth rejecting at parse time).
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _unknown_keys(keys: set[Any]) -> list[str]:
    """Render unsupported mapping keys deterministically.

    YAML mapping keys are not necessarily strings (a plain `1:` is an int), so a
    raw `sorted()` over mixed key types raises TypeError. Sort the rendered form
    instead so an unsupported key is always reported as a `SetupDeclarationError`.
    """
    return sorted(str(key) for key in keys)


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


def is_blank_setup_declaration(content: str) -> bool:
    """Return True when content is empty or only whitespace.

    Blank content means "no declaration", not a malformed one. Callers short
    circuit on this rather than feeding blank text into the parser, which would
    otherwise reject `None` (from an empty load) as "not a mapping".
    """
    return content.strip() == ""


def parse_setup_declaration(content: str) -> SetupDeclaration:
    """Parse declaration content. Raises SetupDeclarationError on anything unexpected.

    Blank content is not a valid declaration to *parse*; callers that treat blank
    as "no declaration" must check :func:`is_blank_setup_declaration` first.
    """
    if is_blank_setup_declaration(content):
        raise SetupDeclarationError(
            "Setup declaration is blank; blank content means no declaration."
        )
    if len(content.encode("utf-8")) > MAX_SETUP_DECLARATION_BYTES:
        raise SetupDeclarationError(
            f"Setup declaration exceeds {MAX_SETUP_DECLARATION_BYTES} bytes."
        )
    # Reject explicit YAML tags (`!!bool`, `!!str`, `!!seq`, ...) before loading.
    # The declaration format is the plain YAML 1.2 Core schema; a maintainer
    # never needs an explicit tag, and the two libraries disagree about them:
    # `yaml` (TS) silently falls back to the raw string when a tag's scalar does
    # not match, while `yamlcore`/PyYAML raise -- sometimes a raw `KeyError`/
    # `IndexError` from inside a constructor, not a `YAMLError`. Rejecting every
    # explicit tag here keeps the two enforcers identical and turns a malformed
    # tag into a clean declaration error instead of an internal traceback.
    try:
        for event in yaml.parse(content, Loader=yamlcore.CCoreLoader):
            if getattr(event, "tag", None) is not None:
                raise SetupDeclarationError(
                    "Setup declaration must not use explicit YAML tags "
                    f"({event.tag}). Use plain scalars; the YAML 1.2 Core "
                    "schema already resolves booleans, numbers, and null."
                )
    except yaml.YAMLError as error:
        raise SetupDeclarationError(
            f"Setup declaration is not valid YAML: {error}"
        ) from error

    try:
        # Parse with the YAML 1.2 Core schema (via yamlcore), the same schema
        # the GitHub integration uses (`yaml` with `schema: 'core'`). The two
        # libraries then resolve every scalar the same way, so a declaration is
        # accepted or rejected identically on both sides. In particular
        # `on`/`yes`/`no`/`off`/`y`/`n` are plain strings under 1.2, not
        # booleans, so a `run: on` is a command string rather than a parse error.
        parsed: Any = yaml.load(content, Loader=yamlcore.CCoreLoader)
    except yaml.YAMLError as error:
        raise SetupDeclarationError(
            f"Setup declaration is not valid YAML: {error}"
        ) from error
    except (ValueError, KeyError, TypeError, IndexError) as error:
        # Defensive: a loader/constructor bug raising a raw Python error is
        # still a declaration error to the caller, never an internal traceback.
        raise SetupDeclarationError(
            f"Setup declaration could not be constructed: {error}"
        ) from error

    if not isinstance(parsed, dict):
        raise SetupDeclarationError(
            "Setup declaration must be a mapping at the top level."
        )

    unknown_top_level = _unknown_keys(set(parsed) - {"setup"})
    if unknown_top_level:
        raise SetupDeclarationError(
            "Setup declaration has unsupported top-level key(s): "
            + ", ".join(unknown_top_level)
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

    unknown = _unknown_keys(set(raw_step) - _ALLOWED_STEP_KEYS)
    if unknown:
        raise SetupDeclarationError(
            f"{label} has unsupported key(s): {', '.join(unknown)}"
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
    parts = normalized.split("/")
    if normalized.startswith("/") or parts[0] == "..":
        raise SetupDeclarationError(
            f"{label}.working-directory must be relative to the repository root: {value!r}"
        )
    if ".." in parts:
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
        # The cap bounds the *effective* timeout, so it also applies to the
        # default: an operator who lowers SEC_REVIEW_SETUP_STEP_MAX_SECONDS
        # below the default must still see it enforced on steps that omit
        # `timeout_seconds`.
        return min(DEFAULT_STEP_TIMEOUT_SECONDS, max_timeout)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SetupDeclarationError(f"{label}.timeout_seconds must be an integer.")
    if value <= 0:
        raise SetupDeclarationError(f"{label}.timeout_seconds must be positive.")
    return min(value, max_timeout)


__all__ = [
    "DEFAULT_MAX_STEP_TIMEOUT_SECONDS",
    "DEFAULT_STEP_TIMEOUT_SECONDS",
    "MAX_SETUP_DECLARATION_BYTES",
    "MAX_STEP_TIMEOUT_ENV",
    "SetupDeclaration",
    "SetupDeclarationError",
    "SetupDeclarationStep",
    "is_blank_setup_declaration",
    "max_step_timeout_seconds",
    "parse_setup_declaration",
]
