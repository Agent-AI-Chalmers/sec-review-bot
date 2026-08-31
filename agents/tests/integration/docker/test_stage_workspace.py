import shlex
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.workflows.issue.analysis import analyze_issue
from sec_review_agents.workflows.issue.verification import verify_issue
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
@pytest.mark.asyncio
async def test_issue_analyzer_docker_workspace_is_writable_stage_copy(
    tmp_path: Path,
) -> None:
    source_workspace = tmp_path / "source-workspace"
    history = tmp_path / "history"
    artifacts = tmp_path / "artifacts" / "analyzer"
    source_workspace.mkdir(parents=True)
    history.mkdir()
    artifacts.mkdir(parents=True)
    (source_workspace / "app.py").write_text(
        "print('baseline')\n",
        encoding="utf-8",
    )
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=source_workspace,
        tar_path=snapshot_tar,
    )

    stage_workspaces: list[Path] = []

    async def fake_create_agent_graph(**kwargs: Any) -> object:
        return Mock(backend=kwargs["backend"])

    async def fake_invoke_agent_runtime_graph(
        *,
        agent: Any,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        backend = agent.backend
        stage_workspaces.append(_workspace_mount_host(backend, source_workspace))
        _write_workspace_probe(backend, "analyzer")
        return {
            "overview": "ok",
            "narratives": [],
            "overall_verdict": "no-actionable-finding",
        }

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="docker",
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.create_analysis_agent_graph",
            side_effect=fake_create_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        await analyze_issue(
            issue={"title": "demo", "body": "body"},
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=history,
            analyzer_artifacts_path=artifacts,
            review_objective="audit",
        )

    assert len(stage_workspaces) == 1
    assert not (source_workspace / ".agent-index").exists()
    assert not stage_workspaces[0].exists()


@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
@pytest.mark.asyncio
async def test_issue_verifier_docker_workspace_is_writable_stage_copy(
    tmp_path: Path,
) -> None:
    source_workspace = tmp_path / "source-workspace"
    history = tmp_path / "history"
    mitigator_artifacts = tmp_path / "artifacts" / "mitigator"
    verifier_artifacts = tmp_path / "artifacts" / "verifier"
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    source_workspace.mkdir(parents=True)
    history.mkdir()
    mitigator_artifacts.mkdir(parents=True)
    verifier_artifacts.mkdir(parents=True)
    (source_workspace / "app.py").write_text(
        "print('baseline')\n",
        encoding="utf-8",
    )
    create_workspace_snapshot_tar(
        workspace_path=source_workspace,
        tar_path=snapshot_tar,
    )

    stage_workspaces: list[Path] = []

    def fake_create_agent_graph(**kwargs: Any) -> object:
        backend = kwargs["backend"]
        return Mock(backend=backend)

    async def fake_invoke_agent_runtime_graph(
        *,
        agent: Any,
        user_prompt: str,
        config: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        del (
            user_prompt,
            config,
        )
        backend = agent.backend
        assert backend is not None
        stage_workspaces.append(_workspace_mount_host(backend, source_workspace))
        _write_workspace_probe(backend, "verifier")
        return {
            "overview": "No patch was available.",
            "review_target_claim": "demo claim",
            "patch_coverage": "no-patch",
            "resolution_next_step": "manual-review",
            "patch_findings": [],
            "verification_findings": ["No patch was available."],
            "validation_level": "static",
            "regression_status": "not-applicable",
            "residual_risks": [],
        }

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="docker",
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.create_verification_agent_graph",
            side_effect=fake_create_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        result = await verify_issue(
            issue={"title": "demo", "body": "body"},
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=history,
            verifier_artifacts_path=verifier_artifacts,
            analysis_result={
                "status": "completed",
                "overview": "analysis",
                "narratives": [],
            },
            mitigation_result={"changed_files": []},
            retry_context=None,
        )

    assert result["patch_coverage"] == "no-patch"
    assert len(stage_workspaces) == 1
    assert not (source_workspace / ".agent-index").exists()
    assert not stage_workspaces[0].exists()


def _workspace_mount_host(backend: Any, source_workspace: Path) -> Path:
    container_workspace = backend.sandbox_path_for_agent_path(
        "/workspace",
        require_writable=True,
    )
    assert isinstance(container_workspace, str)

    for mount in backend.mounts:
        if mount.writable and mount.container_path == container_workspace:
            host_path = Path(mount.host_path)
            assert host_path != source_workspace
            assert host_path.is_dir()
            return host_path

    raise AssertionError("Docker backend did not expose a writable /workspace mount.")


def _write_workspace_probe(backend: Any, label: str) -> None:
    agent_path = f"/workspace/.agent-index/{label}.txt"
    content = f"{label}-index"
    write_result = backend.write(agent_path, content)
    assert write_result.error is None
    assert write_result.path == agent_path

    read_result = backend.read(agent_path)
    assert read_result.error is None
    assert read_result.file_data["content"] == content

    container_path = backend.sandbox_path_for_agent_path(
        agent_path,
        require_writable=True,
    )
    assert isinstance(container_path, str)
    execute_result = backend.execute(f"test -f {shlex.quote(container_path)}")
    assert (
        execute_result.exit_code == 0
    ), f"expected Docker workspace probe to exist: {execute_result.output}"
