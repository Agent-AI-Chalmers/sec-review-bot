from dataclasses import dataclass, field
from pathlib import Path

import pytest

from sec_review_agents.entrypoints.setup_declaration import SetupDeclarationStep
from sec_review_agents.runtime.setup_bootstrap import (
    BOOTSTRAP_OUTPUT_MAX_CHARS,
    BootstrapStatus,
    bootstrap_environment,
    flatten_step_command,
    record_bootstrap_result,
    setup_declaration_path_for_backend,
)


@dataclass
class _Response:
    exit_code: int = 0
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


def test_flatten_step_command_applies_cwd_and_env(tmp_path: Path) -> None:
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
async def test_no_declaration_is_not_declared(tmp_path: Path) -> None:
    backend = _FakeBackend()
    result = await bootstrap_environment(backend, setup_declaration_path=None)
    assert result.status is BootstrapStatus.NOT_DECLARED
    assert backend.commands == []


@pytest.mark.asyncio
async def test_missing_declaration_file_is_incomplete(tmp_path: Path) -> None:
    backend = _FakeBackend()
    result = await bootstrap_environment(
        backend, setup_declaration_path=tmp_path / "setup.yml"
    )
    assert result.status is BootstrapStatus.INCOMPLETE
    assert result.reason is not None and "not found" in result.reason


@pytest.mark.asyncio
async def test_invalid_declaration_is_incomplete(tmp_path: Path) -> None:
    path = tmp_path / "setup.yml"
    path.write_text("setup: [broken\n", encoding="utf-8")
    backend = _FakeBackend()
    result = await bootstrap_environment(backend, setup_declaration_path=path)
    assert result.status is BootstrapStatus.INCOMPLETE
    assert result.reason is not None and "invalid" in result.reason
    assert backend.commands == []


@pytest.mark.asyncio
async def test_runs_all_steps_on_success(tmp_path: Path) -> None:
    path = tmp_path / "setup.yml"
    path.write_text(
        "setup:\n  - run: one\n  - run: two\n    timeout_seconds: 42\n",
        encoding="utf-8",
    )
    backend = _FakeBackend()
    result = await bootstrap_environment(backend, setup_declaration_path=path)
    assert result.status is BootstrapStatus.COMPLETED
    assert backend.commands == ["cd /workspace && one", "cd /workspace && two"]
    assert backend.timeouts == [300, 42]
    assert len(result.steps) == 2


@pytest.mark.asyncio
async def test_failed_step_stops_and_marks_incomplete(tmp_path: Path) -> None:
    path = tmp_path / "setup.yml"
    path.write_text("setup:\n  - run: one\n  - run: two\n", encoding="utf-8")
    backend = _FakeBackend(responses=[_Response(exit_code=3), _Response()])
    result = await bootstrap_environment(backend, setup_declaration_path=path)
    assert result.status is BootstrapStatus.INCOMPLETE
    assert result.reason is not None and "exit 3" in result.reason
    # second step must not run
    assert backend.commands == ["cd /workspace && one"]
    assert result.steps[0].exit_code == 3


def test_setup_declaration_path_for_backend_docker_only(monkeypatch) -> None:
    bundle_paths = {
        "setup_declaration_path": "/some/bundle/setup-declaration/setup.yml"
    }

    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    assert setup_declaration_path_for_backend(bundle_paths) == Path(
        "/some/bundle/setup-declaration/setup.yml"
    )

    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "bwrap")
    assert setup_declaration_path_for_backend(bundle_paths) is None

    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "local")
    assert setup_declaration_path_for_backend(bundle_paths) is None


def test_setup_declaration_path_for_backend_none_when_missing(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    assert setup_declaration_path_for_backend({}) is None


def test_record_bootstrap_result_truncates_large_output(tmp_path: Path) -> None:
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
