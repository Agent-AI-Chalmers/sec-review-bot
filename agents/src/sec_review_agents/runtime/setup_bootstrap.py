"""Execute the setup declaration inside a stage sandbox.

The declaration text, carried inline in the workflow input, is parsed strictly,
then each step is run inside the container through the deepagents sandbox
contract ``aexecute(command: str, *, timeout: int | None)``. That contract
accepts a full shell command string, so each step is flattened to::

    cd /workspace/<working-directory> && export KEY='value' && <run>

Data (working-directory, env values) is shell-quoted; `run` is intentionally not
quoted because it *is* the command to execute.

Trust boundary
--------------
The declaration is *executable repository content*. Trust in its provenance is
decided upstream (the GitHub integration reads it from the base repository's
default branch, never a fork or payload-supplied ref); this module does not
authenticate it. It runs in the same container, as the same user, with the same
network as the agent, and can therefore modify `/workspace` and anything else
the agent will later read. That is intended: a declaration is only useful if it
can install dependencies in place. Anything that adds a *new* source for
``setup_declaration`` is handing arbitrary code execution to that source -- add
such a source only with that in mind, and keep the default-branch-only rule on
the integration side.

Bootstrap is best-effort: a step failure stops the remaining steps and is
recorded as an incomplete environment, but the review still proceeds.
"""

from __future__ import annotations

import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from sec_review_agents.entrypoints.setup_declaration import (
    SetupDeclaration,
    SetupDeclarationError,
    SetupDeclarationStep,
    is_blank_setup_declaration,
    parse_setup_declaration,
)
from sec_review_agents.filesystem.backend_selection import (
    selected_sandbox_backend_kind,
)
from sec_review_agents.observability.diagnostics import log_diagnostic
from sec_review_agents.utils.files import persist_json

WORKSPACE_ROOT_IN_CONTAINER = "/workspace"

# Cap how much of each step's output is persisted. Bootstrap output can be long
# (installs) and may include registry URLs or tokens; we keep only the tail
# (where errors usually are) and mark truncation. NOTE: truncation is not
# redaction -- artifacts are operator-visible, not secret-free.
BOOTSTRAP_OUTPUT_MAX_CHARS = 2000

# Reported when a step's exit code could not be determined (the sandbox contract
# allows ``None``). Non-zero, so an undetermined run is treated as incomplete.
EXIT_CODE_UNDETERMINED = -1


class _SandboxLike(Protocol):
    async def aexecute(self, command: str, *, timeout: int | None = None) -> Any: ...


class BootstrapStatus(str, Enum):
    NOT_DECLARED = "not_declared"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"


@dataclass(frozen=True)
class BootstrapStepResult:
    run: str
    exit_code: int | None
    output: str


@dataclass(frozen=True)
class BootstrapResult:
    status: BootstrapStatus
    reason: str | None = None
    steps: tuple[BootstrapStepResult, ...] = ()


def setup_declaration_content_for_backend(
    prepared_input: Mapping[str, Any],
) -> str | None:
    """Resolve the setup declaration text for the active backend.

    Only the docker backend surfaces a declaration: its container is long-lived,
    so one bootstrap can be reused for the whole stage. Filtering here rather
    than branching inside the bootstrap keeps bwrap/local out of scope without
    asserting they are unsupported -- they simply have no declaration to run.
    """
    if selected_sandbox_backend_kind() != "docker":
        return None
    value = prepared_input.get("setup_declaration")
    return value if isinstance(value, str) else None


def flatten_step_command(step: SetupDeclarationStep) -> str:
    """Turn one structured declaration step into the shell command to execute."""
    cwd = WORKSPACE_ROOT_IN_CONTAINER
    if step.working_directory:
        cwd = f"{WORKSPACE_ROOT_IN_CONTAINER}/{step.working_directory}"
    parts = [f"cd {shlex.quote(cwd)}"]
    if step.env:
        exports = " && ".join(
            f"export {key}={shlex.quote(value)}" for key, value in step.env.items()
        )
        parts.append(exports)
    parts.append(step.run)
    return " && ".join(parts)


async def bootstrap_environment(
    backend: _SandboxLike,
    *,
    setup_declaration_content: str | None,
) -> BootstrapResult:
    """Run the setup declaration in `backend`'s container, if any."""
    if setup_declaration_content is None or is_blank_setup_declaration(
        setup_declaration_content
    ):
        return BootstrapResult(status=BootstrapStatus.NOT_DECLARED)

    try:
        declaration: SetupDeclaration = parse_setup_declaration(
            setup_declaration_content
        )
    except SetupDeclarationError as error:
        return BootstrapResult(
            status=BootstrapStatus.INCOMPLETE,
            reason=f"invalid setup declaration: {error}",
        )

    results: list[BootstrapStepResult] = []
    for step in declaration.steps:
        command = flatten_step_command(step)
        # Bootstrap is best-effort: the review must still proceed, so a failure
        # *anywhere* in this loop -- including the sandbox itself raising (a
        # container that cannot start, a failed exec, a transport error) -- is
        # recorded as an incomplete environment rather than propagating and
        # aborting the stage.
        try:
            response = await backend.aexecute(command, timeout=step.timeout_seconds)
        # A backend failure is a bootstrap failure; no narrower type applies across backends.
        except Exception as error:
            return BootstrapResult(
                status=BootstrapStatus.INCOMPLETE,
                reason=f"setup step could not run ({error!r}): {step.run}",
                steps=tuple(results),
            )

        exit_code = _exit_code_from_response(response)
        output = str(getattr(response, "output", ""))
        results.append(
            BootstrapStepResult(run=step.run, exit_code=exit_code, output=output)
        )
        if exit_code != 0:
            return BootstrapResult(
                status=BootstrapStatus.INCOMPLETE,
                reason=f"setup step failed (exit {exit_code}): {step.run}",
                steps=tuple(results),
            )

    return BootstrapResult(status=BootstrapStatus.COMPLETED, steps=tuple(results))


def _exit_code_from_response(response: Any) -> int:
    """Read a step's exit code, treating an undetermined code as a failure.

    The sandbox contract types ``exit_code`` as ``int | None``: ``None`` means the
    code could not be determined (e.g. a timeout on a backend that reports it
    that way). That is not success, so it maps to a non-zero sentinel instead of
    raising.
    """
    exit_code = getattr(response, "exit_code", None)
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        return EXIT_CODE_UNDETERMINED
    return exit_code


def _summarize_output(output: str) -> str:
    if len(output) <= BOOTSTRAP_OUTPUT_MAX_CHARS:
        return output
    tail = output[-BOOTSTRAP_OUTPUT_MAX_CHARS:]
    return f"...[{len(output) - BOOTSTRAP_OUTPUT_MAX_CHARS} chars truncated]...\n{tail}"


def record_bootstrap_result(artifacts_path: Path, result: BootstrapResult) -> None:
    """Record the bootstrap outcome as a stage diagnostic (visible, not silent).

    The environment-incomplete state must be discoverable by operators and by a
    human reading the run; it is recorded as a stage artifact ("environment.json")
    and a structured diagnostic log. It is deliberately kept out of the agent's
    context: the agent should reason from the repository, not from host setup
    details that it cannot act on.

    Each step's output is persisted **truncated** to a tail window; this bounds
    volume but is **not redaction** -- artifacts are operator-visible and may
    contain registry URLs/tokens from install commands.
    """
    log_diagnostic(
        "setup_bootstrap",
        status=result.status.value,
        reason=result.reason,
        steps=len(result.steps),
    )
    persist_json(
        artifacts_path,
        "environment.json",
        {
            "environment_incomplete": result.status is BootstrapStatus.INCOMPLETE,
            "setup_status": result.status.value,
            "reason": result.reason,
            "steps": [
                {
                    "run": step.run,
                    "exit_code": step.exit_code,
                    "output": _summarize_output(step.output),
                }
                for step in result.steps
            ],
        },
    )


__all__ = [
    "BOOTSTRAP_OUTPUT_MAX_CHARS",
    "EXIT_CODE_UNDETERMINED",
    "BootstrapResult",
    "BootstrapStatus",
    "BootstrapStepResult",
    "bootstrap_environment",
    "flatten_step_command",
    "record_bootstrap_result",
    "setup_declaration_content_for_backend",
]
