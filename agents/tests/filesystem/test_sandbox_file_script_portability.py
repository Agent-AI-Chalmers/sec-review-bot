"""Sandbox scripts must parse on the interpreter the sandbox actually provides.

These files are not host code. Each is shipped into the sandbox and run with whatever `python3`
the image or host provides. Checking only against the host interpreter can accept newer syntax
that fails inside a sandbox running an older interpreter.

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
import sys
from collections.abc import Callable
from dataclasses import dataclass

import pytest

from sec_review_agents.filesystem.docker_listing import directory_listing_script
from sec_review_agents.filesystem.docker_transfer_ops import docker_transfer_script


@dataclass(frozen=True)
class SandboxScript:
    """One script shipped to the sandbox, with the grammar it needs to keep supporting.

    The transfer helper must remain runnable on Python 3.5 sandbox images.
    Upstream owns most file-operation scripts; this covers project-owned scripts.
    """

    name: str
    minimum_python: tuple[int, int]
    build_source: Callable[[], str]


SANDBOX_SCRIPTS = (
    SandboxScript(
        name="directory_listing_script",
        minimum_python=(3, 5),
        build_source=lambda: directory_listing_script("/workspace"),
    ),
    SandboxScript(
        name="docker_transfer_script_program.py",
        minimum_python=(3, 5),
        build_source=lambda: docker_transfer_script(
            operation="download", root="/workspace", relative_parts=("a.txt",)
        ),
    ),
)


# Every version from a script's floor up to the interpreter running this test. A sandbox may run
# any of them, and deriving the range means a host upgrade cannot silently leave a version
# untested.
INTERMEDIATE_CASES = [
    pytest.param(script, minor, id=f"{script.name}-3.{minor}")
    for script in SANDBOX_SCRIPTS
    for minor in range(script.minimum_python[1], sys.version_info.minor + 1)
]


@pytest.mark.parametrize(("script", "minor"), INTERMEDIATE_CASES)
def test_sandbox_script_parses_on_every_supported_python(
    script: SandboxScript, minor: int
) -> None:
    """One case per version from the script's floor up to the host interpreter.

    Formatting host code must not introduce syntax that older
    sandbox interpreters cannot parse.
    """
    ast.parse(script.build_source(), feature_version=(3, minor))
