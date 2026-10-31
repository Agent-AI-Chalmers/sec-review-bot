"""Invocation memory must outlive its backend, including failed stage execution."""

import asyncio
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.filesystem.path_views import memory_view, workspace_view
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "role", ["analysis", "mitigation", "verification", "single_agent"]
)
@pytest.mark.parametrize("failure", ["create", "agent", "cancel"])
async def test_stage_releases_backend_before_memory_on_failure(
    tmp_path: Path, monkeypatch, role: str, failure: str
) -> None:
    stage = import_module(f"sec_review_agents.review_stages.{role}.stage")
    source = tmp_path / "source"
    source.mkdir()
    snapshot = tmp_path / "workspace.tar"
    create_workspace_snapshot_tar(workspace_path=source, tar_path=snapshot)
    memory = tmp_path / "memory"
    events: list[str] = []

    @contextmanager
    def materialize():
        memory.mkdir()
        try:
            yield memory_view(host_path=memory)
        finally:
            events.append("memory-close")
            memory.rmdir()

    def configure(workspace: Path) -> BackendConfig:
        config = BackendConfig(
            container_name_prefix="test",
            path_views=[workspace_view(host_path=workspace, writable=True)],
            image=None,
            backend_kind="local",
        )
        return config

    class Backend:
        async def aclose(self):
            assert memory.exists()
            events.append("backend-close")

    def create(**kwargs):
        assert memory.exists()
        view = kwargs["path_views"][-1]
        assert view.agent_path == "/memory"
        assert not view.writable
        assert view.host_path == memory
        if failure == "create":
            raise RuntimeError("creation failed")
        return Backend()

    async def run_agent(**kwargs):
        assert kwargs["memory_enabled"] is True
        assert memory.exists()
        if failure == "cancel":
            raise asyncio.CancelledError()
        raise RuntimeError("agent failed")

    monkeypatch.setattr(stage, "materialized_memory_view", materialize)
    monkeypatch.setattr(stage, "create_backend_with_path_views", create)
    agent_name = "run_single_agent" if role == "single_agent" else f"run_{role}_agent"
    monkeypatch.setattr(stage, agent_name, run_agent)
    monkeypatch.setattr(stage, "bootstrap_environment", AsyncMock())
    monkeypatch.setattr(stage, "record_bootstrap_result", lambda *args, **kwargs: None)
    kwargs = {
        "agent_name": "probe",
        "baseline_snapshot_tar_path": snapshot,
        "build_backend_config": configure,
        "system_prompt": "system",
        "filesystem_system_prompt": "filesystem",
        "user_prompt": "user",
    }
    artifact_key = {
        "analysis": "analyzer_artifacts_path",
        "mitigation": "mitigator_artifacts_path",
        "verification": "verifier_artifacts_path",
        "single_agent": "single_agent_artifacts_path",
    }[role]
    kwargs[artifact_key] = tmp_path / "artifacts"
    if role == "mitigation":
        kwargs["retry_context"] = None
    elif role == "verification":
        kwargs.update(
            attempt_label="initial", workspace_patch=None, mitigation_result=None
        )
    elif role == "single_agent":
        kwargs.update(todo_system_prompt="todo", todo_tool_description="plan")
    with pytest.raises(asyncio.CancelledError if failure == "cancel" else RuntimeError):
        await getattr(stage, f"run_{role}_stage")(**kwargs)
    assert events == (
        ["memory-close"] if failure == "create" else ["backend-close", "memory-close"]
    )
    assert not memory.exists()
