from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import pytest

from sec_review_agents.workflows.issue.analysis import analyze_issue
from sec_review_agents.workflows.repository_case.cvss import score_repository_cvss_v4
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


@pytest.mark.asyncio
async def test_issue_analyzer_uses_stage_owned_workspace_copy(tmp_path: Path) -> None:
    source_workspace = tmp_path / "source-workspace"
    history = tmp_path / "history"
    artifacts = tmp_path / "artifacts" / "analyzer"
    source_workspace.mkdir(parents=True)
    history.mkdir()
    (source_workspace / "app.py").write_text("print('source')\n")
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=source_workspace,
        tar_path=snapshot_tar,
    )
    captured_workspace: list[Path] = []

    async def fake_create_agent_graph(**kwargs: Any) -> object:
        return Mock(backend=kwargs["backend"])

    async def fake_invoke_agent_runtime_graph(
        *,
        agent: Any,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        backend = agent.backend
        workspace = backend.routes["/workspace/"].root_dir
        assert isinstance(workspace, Path)
        captured_workspace.append(workspace)
        assert workspace != source_workspace
        assert (workspace / "app.py").read_text() == "print('source')\n"
        return {
            "overview": "ok",
            "narratives": [],
            "overall_verdict": "no-actionable-finding",
        }

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
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

    assert len(captured_workspace) == 1
    assert not captured_workspace[0].exists()
    assert source_workspace.exists()


@pytest.mark.asyncio
async def test_repository_cvss_uses_stage_owned_workspace_copy(tmp_path: Path) -> None:
    source_workspace = tmp_path / "source-workspace"
    artifacts = tmp_path / "artifacts" / "cvss"
    source_workspace.mkdir(parents=True)
    (source_workspace / "app.py").write_text("print('source')\n")
    snapshot_tar = tmp_path / "cvss-workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=source_workspace,
        tar_path=snapshot_tar,
    )
    captured_workspace: list[Path] = []

    async def fake_create_cvss_agent_graph(**kwargs: Any) -> object:
        return Mock(backend=kwargs["backend"])

    async def fake_invoke_cvss_agent(
        *,
        agent: Any,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        backend = agent.backend
        workspace_route = backend.routes["/workspace/"]
        workspace = workspace_route.root_dir
        assert isinstance(workspace, Path)
        captured_workspace.append(workspace)
        assert workspace != source_workspace
        assert (workspace / "app.py").read_text() == "print('source')\n"
        return {
            "scoring_status": "not-scored",
            "overview": "ok",
            "not_scored_reason": "test case",
        }

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
        patch(
            "sec_review_agents.review_stages.cvss.stage.create_cvss_agent_graph",
            side_effect=fake_create_cvss_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.cvss.stage.invoke_agent_runtime_graph",
            side_effect=fake_invoke_cvss_agent,
        ),
    ):
        await score_repository_cvss_v4(
            cvss_artifacts_path=artifacts,
            workspace_snapshot_tar_path=snapshot_tar,
            review_input="review input",
            analysis_result={
                "verdict": "confirmed-vulnerability",
                "narratives": [
                    {
                        "verdict": "confirmed-vulnerability",
                        "priority": 1,
                    }
                ],
            },
        )

    assert len(captured_workspace) == 1
    assert not captured_workspace[0].exists()
    assert source_workspace.exists()
