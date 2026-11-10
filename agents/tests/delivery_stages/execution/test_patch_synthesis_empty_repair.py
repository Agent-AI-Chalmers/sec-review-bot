import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput
from sec_review_agents.delivery_stages.execution.input import DeliveryPatchCase
from sec_review_agents.delivery_stages.execution.stage import execute_delivery_entry
from sec_review_agents.delivery_stages.model import DeliveryEntry
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.mark.asyncio
async def test_empty_synthesis_reports_the_agent_overview(tmp_path: Path) -> None:
    """Synthesis commits nothing when cases contradict; the overview says why.

    Without it the failed delivery records only that the repair was empty, and a
    reader cannot tell a contradiction from an agent that forgot to commit.
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "a.py").write_text("x = 1\n", encoding="utf-8")
    _git(repo, "init", "-q")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "base")
    snapshot = create_workspace_snapshot_tar(
        workspace_path=repo, tar_path=tmp_path / "baseline.tar"
    )
    overview = "case-a forbids pickle while case-b requires it; no commit."
    agent = AsyncMock(return_value=PatchSynthesisOutput(overview=overview))

    with (
        patch(
            "sec_review_agents.delivery_stages.execution.patch_synthesis."
            "run_patch_synthesis_agent",
            agent,
        ),
        patch(
            "sec_review_agents.delivery_stages.execution.patch_synthesis."
            "create_patch_synthesis_backend",
        ),
        patch(
            "sec_review_agents.delivery_stages.execution.patch_synthesis."
            "amanaged_backend",
        ) as managed,
    ):
        managed.return_value.__aenter__ = AsyncMock()
        managed.return_value.__aexit__ = AsyncMock(return_value=False)
        result = await execute_delivery_entry(
            run_artifacts_root=tmp_path / "artifacts",
            workspace_snapshot_tar_path=snapshot,
            delivery_entry=DeliveryEntry(
                delivery_id="delivery-1",
                strategy="combined",
                case_ids=["case-a", "case-b"],
                reason="same function",
            ),
            case_results=[
                DeliveryPatchCase(
                    case_id=case_id,
                    mitigator_file_changes=[],
                    mitigator_patch_diff="",
                )
                for case_id in ("case-a", "case-b")
            ],
        )

    agent.assert_awaited_once()
    assert result is not None
    assert result.status == "failed"
    assert result.error is not None
    assert overview in result.error
