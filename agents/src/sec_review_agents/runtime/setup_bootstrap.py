"""Execute the setup declaration inside a stage sandbox.

The declaration text, carried inline in the workflow input, is parsed strictly,
then each step is run inside the container through the deepagents sandbox
contract:
``execute(command: str)``. The contract accepts a full shell command string, so
each step is flattened to::

    cd /workspace/<working-directory> && export KEY='value' && <run>

Data (working-directory, env values) is shell-quoted; `run` is intentionally not
quoted because it *is* the command to execute.

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
    if setup_declaration_content is None:
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
        response = await backend.aexecute(command, timeout=step.timeout_seconds)
        exit_code = int(getattr(response, "exit_code", 1))
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
    "BootstrapResult",
    "BootstrapStatus",
    "BootstrapStepResult",
    "bootstrap_environment",
    "flatten_step_command",
    "record_bootstrap_result",
    "setup_declaration_content_for_backend",
]
