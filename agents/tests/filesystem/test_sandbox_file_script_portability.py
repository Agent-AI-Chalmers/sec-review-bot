"""Sandbox scripts must parse on the interpreter the sandbox actually provides.

These files are not host code. Each is shipped into the sandbox and run with whatever `python3`
the image or host provides, so the project's own 3.14 interpreter is the wrong target: syntax that
only 3.14 accepts passes every other test here and fails only inside a run.

`ast.parse(..., feature_version=...)` checks a source against an older grammar without that
interpreter being installed, so this regression needs no CI matrix.

What it catches and what it does not:

- It rejects syntax the older grammar cannot parse: `except A, B:` (3.14), `match` (3.10),
  `except*` (3.11), and assignment expressions (3.8). Those are what a formatter or a careless
  edit reintroduces, and they are the reason this test exists.
- It accepts anything the older grammar can parse even when the feature needs a newer runtime:
  `dict |= other` (3.9), `str.removeprefix` (3.9), or `list[str]` evaluated at runtime (3.9).
  Those fail only inside the sandbox, and this test will not notice them.

So each floor below is the version the script's own syntax requires, not a claim that every
newer runtime API is avoided. Pair this with the rule that these scripts stay deliberately plain.
"""

import ast
from collections.abc import Callable
from dataclasses import dataclass

import pytest

from sec_review_agents.filesystem.docker_transfer_ops import docker_transfer_script
from sec_review_agents.filesystem.sandbox_file_ops import file_operation_script


@dataclass(frozen=True)
class SandboxScript:
    """One script shipped to the sandbox, with the grammar it needs to keep supporting.

    Each script declares its own floor because the requirement belongs to the script's syntax, not
    to the test: the transfer helper uses assignment expressions (3.8), while the filesystem
    helper annotates locals with builtin generics such as `list[str]` (3.9).
    """

    name: str
    minimum_python: tuple[int, int]
    build_source: Callable[[], str]


SANDBOX_SCRIPTS = (
    SandboxScript(
        name="sandbox_file_script_program.py",
        minimum_python=(3, 9),
        build_source=lambda: file_operation_script(
            {"op": "ls", "path": "/workspace", "limits": {"ls_max_entries": 1}}
        ),
    ),
    SandboxScript(
        name="docker_transfer_script_program.py",
        minimum_python=(3, 8),
        build_source=lambda: docker_transfer_script(
            operation="download", root="/workspace", relative_parts=("a.txt",)
        ),
    ),
)


def _parses(source: str, version: tuple[int, int]) -> bool:
    try:
        ast.parse(source, feature_version=version)
    except SyntaxError:
        return False
    return True


@pytest.mark.parametrize(
    "script", SANDBOX_SCRIPTS, ids=[script.name for script in SANDBOX_SCRIPTS]
)
def test_sandbox_script_parses_on_its_minimum_python(script: SandboxScript) -> None:
    """Black under `target-version = py314` once rewrote a tuple of exception types in
    `sandbox_file_script_program.py` into the Python 2 `except A, B:` form, which is valid syntax
    only from 3.14. Every host test kept passing while the sandbox could no longer list files, so
    the compatibility claim needs a test that names the older grammar explicitly.
    """
    assert _parses(script.build_source(), script.minimum_python)


@pytest.mark.parametrize(
    "script", SANDBOX_SCRIPTS, ids=[script.name for script in SANDBOX_SCRIPTS]
)
@pytest.mark.parametrize("minor", [11, 12, 13])
def test_sandbox_script_parses_on_every_intermediate_python(
    script: SandboxScript, minor: int
) -> None:
    """A sandbox may run any version between the declared floor and the host interpreter."""
    if (3, minor) < script.minimum_python:
        pytest.skip("below this script's declared floor")
    assert _parses(script.build_source(), (3, minor))
