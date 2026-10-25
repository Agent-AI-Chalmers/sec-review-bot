from dataclasses import dataclass, field

import pytest

from sec_review_agents.entrypoints.setup_declaration import (
    SetupDeclarationError,
    SetupDeclarationStep,
)
from sec_review_agents.runtime.setup_bootstrap import (
    BOOTSTRAP_OUTPUT_MAX_CHARS,
    EXIT_CODE_UNDETERMINED,
    BootstrapStatus,
    bootstrap_environment,
    flatten_step_command,
    record_bootstrap_result,
    setup_declaration_content_for_backend,
)


@dataclass
class _Response:
    exit_code: int | None = 0
    output: str = ""


@dataclass
class _FakeBackend:
    responses: list[_Response] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    timeouts: list[int | None] = field(default_factory=list)

    async def aexecute(self, command: str, *, timeout: int | None = None) -> _Response:
        self.commands.append(command)
        self.timeouts.append(timeout)
        if self.responses:
            return self.responses.pop(0)
        return _Response()


def test_flatten_step_command_applies_cwd_and_env() -> None:
    step = SetupDeclarationStep(
        run="pnpm install",
        working_directory="apps/svc",
        env={"NODE_ENV": "development", "A": "b c"},
        timeout_seconds=300,
    )
    command = flatten_step_command(step)
    assert command == (
        "cd /workspace/apps/svc && export NODE_ENV=development && export A='b c' && pnpm install"
    )


def test_flatten_step_command_without_optional_fields() -> None:
    step = SetupDeclarationStep(
        run="uv sync", working_directory=None, env={}, timeout_seconds=300
    )
    assert flatten_step_command(step) == "cd /workspace && uv sync"


@pytest.mark.asyncio
async def test_no_declaration_is_not_declared() -> None:
    backend = _FakeBackend()
    result = await bootstrap_environment(backend, setup_declaration_content=None)
    assert result.status is BootstrapStatus.NOT_DECLARED
    assert backend.commands == []


@pytest.mark.asyncio
async def test_unparseable_declaration_raises_instead_of_degrading() -> None:
    # A declaration that is present but does not parse can never prepare the
    # environment it asked for, so it fails the run loudly rather than silently
    # degrading to an unbootstrapped one. This case can only come from a
    # producer/worker format disagreement or an unvalidated out-of-band caller.
    backend = _FakeBackend()
    with pytest.raises(SetupDeclarationError):
        await bootstrap_environment(
            backend, setup_declaration_content="setup: [broken\n"
        )
    assert backend.commands == []


@pytest.mark.asyncio
async def test_runs_all_steps_on_success() -> None:
    backend = _FakeBackend()
    result = await bootstrap_environment(
        backend,
        setup_declaration_content="setup:\n  - run: one\n  - run: two\n    timeout_seconds: 42\n",
    )
    assert result.status is BootstrapStatus.COMPLETED
    assert backend.commands == ["cd /workspace && one", "cd /workspace && two"]
    assert backend.timeouts == [300, 42]
    assert len(result.steps) == 2


@pytest.mark.asyncio
async def test_failed_step_stops_and_marks_incomplete() -> None:
    backend = _FakeBackend(responses=[_Response(exit_code=3), _Response()])
    result = await bootstrap_environment(
        backend, setup_declaration_content="setup:\n  - run: one\n  - run: two\n"
    )
    assert result.status is BootstrapStatus.INCOMPLETE
    assert result.reason is not None and "exit 3" in result.reason
    # second step must not run
    assert backend.commands == ["cd /workspace && one"]
    assert result.steps[0].exit_code == 3


def test_setup_declaration_content_for_backend_docker_only(monkeypatch) -> None:
    prepared_input = {"setup_declaration": "setup:\n  - run: echo hi\n"}

    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    assert (
        setup_declaration_content_for_backend(prepared_input)
        == "setup:\n  - run: echo hi\n"
    )

    # bwrap is the non-docker backend an operator can still select; `local` is
    # no longer a deployment value.
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "bwrap")
    assert setup_declaration_content_for_backend(prepared_input) is None


def test_setup_declaration_content_for_backend_absent(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    assert setup_declaration_content_for_backend({}) is None


def test_record_bootstrap_result_truncates_large_output(tmp_path) -> None:
    import json

    from sec_review_agents.runtime.setup_bootstrap import (
        BootstrapResult,
        BootstrapStepResult,
    )

    huge = "x" * (BOOTSTRAP_OUTPUT_MAX_CHARS * 3) + "TAIL"
    result = BootstrapResult(
        status=BootstrapStatus.COMPLETED,
        steps=(BootstrapStepResult(run="noisy", exit_code=0, output=huge),),
    )
    record_bootstrap_result(tmp_path, result)
    payload = json.loads((tmp_path / "environment.json").read_text(encoding="utf-8"))
    recorded = payload["steps"][0]["output"]
    assert "chars truncated" in recorded
    assert recorded.endswith("TAIL")
    assert len(recorded) <= BOOTSTRAP_OUTPUT_MAX_CHARS + 200
    # The artifact must not let a reader assume the output was sanitized.
    assert payload["output_redacted"] is False
    assert payload["steps"][0]["output_truncated"] is True


def test_record_bootstrap_result_marks_short_output_untruncated(tmp_path) -> None:
    import json

    from sec_review_agents.runtime.setup_bootstrap import (
        BootstrapResult,
        BootstrapStepResult,
    )

    result = BootstrapResult(
        status=BootstrapStatus.COMPLETED,
        steps=(BootstrapStepResult(run="quiet", exit_code=0, output="ok"),),
    )
    record_bootstrap_result(tmp_path, result)
    payload = json.loads((tmp_path / "environment.json").read_text(encoding="utf-8"))
    assert payload["output_redacted"] is False
    assert payload["steps"][0]["output_truncated"] is False
    assert payload["steps"][0]["output"] == "ok"


class _ExplodingBackend:
    """A backend whose execute raises, modeling a container/exec failure."""

    def __init__(self, error: Exception) -> None:
        self.error = error
        self.commands: list[str] = []

    async def aexecute(self, command: str, *, timeout: int | None = None) -> _Response:
        self.commands.append(command)
        raise self.error


@pytest.mark.asyncio
async def test_backend_exception_is_incomplete_and_skips_remaining_steps() -> None:
    # The sandbox itself raising (container cannot start, exec fails, transport
    # error) must not abort the review: bootstrap is best-effort.
    backend = _ExplodingBackend(RuntimeError("container failed to start"))
    result = await bootstrap_environment(
        backend,
        setup_declaration_content="setup:\n  - run: one\n  - run: two\n",
    )
    assert result.status is BootstrapStatus.INCOMPLETE
    assert result.reason is not None and "could not run" in result.reason
    # Only the first step was attempted; the failure stopped the rest.
    assert backend.commands == ["cd /workspace && one"]
    assert result.steps == ()


@pytest.mark.asyncio
async def test_undetermined_exit_code_is_treated_as_failure() -> None:
    # The sandbox contract allows exit_code=None ("could not be determined");
    # that is not success, so it must mark the environment incomplete rather
    # than raise.
    backend = _FakeBackend(responses=[_Response(exit_code=None)])
    result = await bootstrap_environment(
        backend, setup_declaration_content="setup:\n  - run: one\n"
    )
    assert result.status is BootstrapStatus.INCOMPLETE
    assert result.steps[0].exit_code == EXIT_CODE_UNDETERMINED
    assert result.reason is not None and "exit -1" in result.reason
