"""The stage runs the setup bootstrap before the agent starts."""

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


class _FakeBackend:
    def __init__(self, failing: bool = False) -> None:
        self.commands: list[str] = []
        self._failing = failing

    async def aexecute(self, command: str, *, timeout: int | None = None) -> Any:
        self.commands.append(command)

        class _R:
            exit_code = 1 if self._failing else 0
            output = ""

        return _R()

    async def aclose(self) -> None:
        return None


def _seed(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "app.ts").write_text("export const x = 1\n", encoding="utf-8")
    tar = tmp_path / WORKSPACE_SNAPSHOT_TAR_NAME
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=tar)
    return tar


async def _run(
    tmp_path: Path, *, backend: _FakeBackend, setup_declaration_content: str | None
) -> tuple[dict[str, Any], Path]:
    artifacts = tmp_path / "artifacts" / "analyzer"
    agent_called = {"value": False}

    async def run_agent(**_kwargs: Any) -> dict[str, Any]:
        agent_called["value"] = True
        return {
            "overview": "n/a",
            "narratives": [],
            "overall_verdict": "no-actionable-finding",
        }

    with (
        patch(
            "sec_review_agents.review_stages.analysis.stage.create_backend_with_path_views",
            return_value=backend,
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.run_analysis_agent",
            side_effect=run_agent,
        ),
    ):
        await run_analysis_stage(
            analyzer_artifacts_path=artifacts,
            agent_name="analyzer",
            baseline_snapshot_tar_path=_seed(tmp_path),
            build_backend_config=lambda _ws: BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
            setup_declaration_content=setup_declaration_content,
        )

    return agent_called, artifacts


@pytest.mark.asyncio
async def test_no_declaration_records_not_declared_and_runs_agent(
    tmp_path: Path,
) -> None:
    backend = _FakeBackend()
    agent_called, artifacts = await _run(
        tmp_path, backend=backend, setup_declaration_content=None
    )
    assert agent_called["value"] is True
    assert backend.commands == []
    env = json.loads((artifacts / "environment.json").read_text(encoding="utf-8"))
    assert env["environment_incomplete"] is False
    assert env["setup_status"] == "not_declared"


@pytest.mark.asyncio
async def test_declaration_runs_before_agent_and_records_completed(
    tmp_path: Path,
) -> None:
    backend = _FakeBackend()
    agent_called, artifacts = await _run(
        tmp_path,
        backend=backend,
        setup_declaration_content="setup:\n  - run: echo one\n  - run: echo two\n",
    )
    assert agent_called["value"] is True
    assert backend.commands == [
        "cd /workspace && echo one",
        "cd /workspace && echo two",
    ]
    env = json.loads((artifacts / "environment.json").read_text(encoding="utf-8"))
    assert env["environment_incomplete"] is False
    assert env["setup_status"] == "completed"


@pytest.mark.asyncio
async def test_failed_step_marks_incomplete_but_agent_still_runs(
    tmp_path: Path,
) -> None:
    backend = _FakeBackend(failing=True)
    agent_called, artifacts = await _run(
        tmp_path,
        backend=backend,
        setup_declaration_content="setup:\n  - run: 'false'\n  - run: echo never\n",
    )
    assert agent_called["value"] is True
    assert backend.commands == ["cd /workspace && false"]
    env = json.loads((artifacts / "environment.json").read_text(encoding="utf-8"))
    assert env["environment_incomplete"] is True
    assert env["setup_status"] == "incomplete"


@pytest.mark.asyncio
@pytest.mark.parametrize("with_memory", [False, True])
async def test_stage_assembles_invocation_mounts(
    tmp_path: Path, with_memory: bool
) -> None:
    """Memory reaches backend creation without entering the layout callback."""
    from contextlib import contextmanager

    from sec_review_agents.filesystem.path_views import memory_view, workspace_view

    memory_root = tmp_path / "memory"
    closed: list[bool] = []

    @contextmanager
    def materialize():
        memory_root.mkdir()
        try:
            yield memory_view(host_path=memory_root) if with_memory else None
        finally:
            assert closed == [True]
            memory_root.rmdir()

    class Backend(_FakeBackend):
        async def aclose(self) -> None:
            assert memory_root.exists()
            closed.append(True)

    backend = Backend()

    def configure(workspace: Path) -> BackendConfig:
        assert (workspace / "src/app.ts").exists()
        config = BackendConfig(
            container_name_prefix="probe",
            path_views=[workspace_view(host_path=workspace, writable=True)],
            image=None,
            backend_kind="local",
        )
        return config

    def create(**kwargs):
        assert memory_root.exists()
        assert [view.agent_path for view in kwargs["path_views"]] == (
            ["/workspace", "/memory"] if with_memory else ["/workspace"]
        )
        return backend

    async def run_agent(**kwargs):
        assert kwargs["backend"] is backend
        assert kwargs["memory_enabled"] is with_memory
        assert memory_root.exists()
        return {
            "overview": "ok",
            "narratives": [],
            "overall_verdict": "no-actionable-finding",
        }

    with (
        patch(
            "sec_review_agents.review_stages.analysis.stage.materialized_memory_view",
            materialize,
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.create_backend_with_path_views",
            side_effect=create,
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.run_analysis_agent",
            side_effect=run_agent,
        ),
    ):
        await run_analysis_stage(
            analyzer_artifacts_path=tmp_path / "artifacts",
            agent_name="probe",
            baseline_snapshot_tar_path=_seed(tmp_path),
            build_backend_config=configure,
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
        )
    assert not memory_root.exists()
