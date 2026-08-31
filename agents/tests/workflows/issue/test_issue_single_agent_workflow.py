from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.workflows.issue.single_agent import execute_issue_single_agent
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


def _prepare_snapshot(root: Path) -> None:
    workspace = root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    create_workspace_snapshot_tar(
        workspace_path=workspace,
        tar_path=root / WORKSPACE_SNAPSHOT_TAR_NAME,
    )


@pytest.mark.asyncio
async def test_single_agent_workflow_with_model_access_returns_compact_shape(
    tmp_path: Path,
) -> None:
    root = tmp_path
    _prepare_snapshot(root)
    single_agent_artifacts = root / "single-agent"
    input_data: dict[str, Any] = {
        "run_id": "run-single-complete",
        "issue": {
            "title": "demo",
            "body": "body",
        },
        "input_bundle_root_path": str(root),
    }
    structured_payload = {
        "overview": "Applied a fix after validating the issue.",
        "verdict": "confirmed-vulnerability",
        "validation_level": "static",
        "regression_status": "not-run",
        "target_claim": "The issue allowed attacker-controlled path traversal.",
        "declared_changed_files": ["app.py"],
        "residual_risks": [],
        "self_check_notes": [
            "Reviewed sibling file access path and verified the guard is shared."
        ],
    }

    with (
        patch(
            "sec_review_agents.review_stages.single_agent.stage.restore_workspace_from_snapshot_tar",
            side_effect=lambda **kwargs: kwargs["destination_path"],
        ),
        patch(
            "sec_review_agents.agents.single_agent.issue.create_issue_single_agent_backend",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.create_single_agent_graph",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.invoke_agent_runtime_graph",
            return_value=structured_payload,
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.persist_workspace_patch",
            return_value={
                "patch_content": "diff --git a/app.py b/app.py\n",
                "changed_files": ["app.py"],
            },
        ),
    ):
        result = await execute_issue_single_agent(
            issue=input_data["issue"],
            workspace_snapshot_tar_path=Path(input_data["input_bundle_root_path"])
            / "workspace.snapshot.tar",
            history_path=Path(input_data["input_bundle_root_path"]) / "history",
            single_agent_artifacts_path=single_agent_artifacts,
            review_objective="audit",
            repair_mode=REPAIR_MODE_TEST_CHANGES_ALLOWED,
        )

    assert set(result) == {"kind", "review_record"}
    assert result["kind"] == "issue-single-agent-strategy-result"
    review_record = result["review_record"]
    assert set(review_record) == {"analysis", "mitigation", "verification", "cvss"}
    assert review_record["mitigation"]["changed_files"] == ["app.py"]


@pytest.mark.asyncio
async def test_single_agent_workflow_does_not_fall_back_to_failed_when_agent_declares_changed_files(
    tmp_path: Path,
) -> None:
    root = tmp_path
    _prepare_snapshot(root)
    input_data: dict[str, Any] = {
        "run_id": "run-single-regression",
        "issue": {
            "title": "demo",
            "body": "body",
        },
        "input_bundle_root_path": str(root),
        "artifact_paths": {},
    }
    structured_payload = {
        "overview": "Applied a fix after validating the issue.",
        "verdict": "confirmed-defect",
        "validation_level": "static",
        "regression_status": "not-run",
        "target_claim": "The issue allowed attacker-controlled path traversal.",
        "declared_changed_files": ["app.py"],
        "residual_risks": [],
        "self_check_notes": [
            "Reviewed sibling file access path and verified the guard is shared."
        ],
    }

    with (
        patch(
            "sec_review_agents.review_stages.single_agent.stage.restore_workspace_from_snapshot_tar",
            side_effect=lambda **kwargs: kwargs["destination_path"],
        ),
        patch(
            "sec_review_agents.agents.single_agent.issue.create_issue_single_agent_backend",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.create_single_agent_graph",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.invoke_agent_runtime_graph",
            return_value=structured_payload,
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.persist_workspace_patch",
            return_value={
                "patch_content": "diff --git a/app.py b/app.py\n",
                "changed_files": ["app.py"],
            },
        ),
    ):
        result = await execute_issue_single_agent(
            issue=input_data["issue"],
            workspace_snapshot_tar_path=Path(input_data["input_bundle_root_path"])
            / "workspace.snapshot.tar",
            history_path=Path(input_data["input_bundle_root_path"]) / "history",
            single_agent_artifacts_path=root / "single-agent",
            review_objective="audit",
            repair_mode=REPAIR_MODE_TEST_CHANGES_ALLOWED,
        )
        default_artifact_result_exists = (
            root / "single-agent" / "single-agent-result.json"
        ).exists()

    assert set(result) == {"kind", "review_record"}
    assert result["review_record"]["mitigation"]["changed_files"] == ["app.py"]
    assert default_artifact_result_exists
