from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.agents.single_agent.model import SingleAgentFixOutput
from sec_review_agents.workflows.issue.single_agent import execute_issue_single_agent
from sec_review_agents.workflows.review_intent import TEST_CHANGES_ALLOW
from sec_review_agents.workspace.patches import PatchArtifact
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
            "sec_review_agents.agents.single_agent.issue.build_issue_single_agent_backend_config",
            return_value=BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.run_single_agent",
            return_value=SingleAgentFixOutput.model_validate(structured_payload),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.build_patch_artifact",
            return_value=PatchArtifact.model_validate(
                {
                    "patch_diff": "diff --git a/app.py b/app.py\n",
                    "file_changes": [{"path": "app.py", "status": "deleted"}],
                }
            ),
        ),
    ):
        result = await execute_issue_single_agent(
            issue=input_data["issue"],
            workspace_snapshot_tar_path=Path(input_data["input_bundle_root_path"])
            / "workspace.snapshot.tar",
            history_path=Path(input_data["input_bundle_root_path"]) / "history",
            single_agent_artifacts_path=single_agent_artifacts,
            review_objective="audit",
            test_changes=TEST_CHANGES_ALLOW,
        )

    assert set(result) == {"kind", "review_record"}
    assert result["kind"] == "issue-single-agent-strategy-result"
    review_record = result["review_record"]
    assert set(review_record) == {"analysis", "mitigation", "verification", "cvss"}
    assert review_record["mitigation"]["file_changes"] == [
        {"path": "app.py", "status": "deleted"}
    ]


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
            "sec_review_agents.agents.single_agent.issue.build_issue_single_agent_backend_config",
            return_value=BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.run_single_agent",
            return_value=SingleAgentFixOutput.model_validate(structured_payload),
        ),
        patch(
            "sec_review_agents.review_stages.single_agent.stage.build_patch_artifact",
            return_value=PatchArtifact.model_validate(
                {
                    "patch_diff": "diff --git a/app.py b/app.py\n",
                    "file_changes": [{"path": "app.py", "status": "deleted"}],
                }
            ),
        ),
    ):
        result = await execute_issue_single_agent(
            issue=input_data["issue"],
            workspace_snapshot_tar_path=Path(input_data["input_bundle_root_path"])
            / "workspace.snapshot.tar",
            history_path=Path(input_data["input_bundle_root_path"]) / "history",
            single_agent_artifacts_path=root / "single-agent",
            review_objective="audit",
            test_changes=TEST_CHANGES_ALLOW,
        )
        default_artifact_result_exists = (
            root / "single-agent" / "single-agent-result.json"
        ).exists()

    assert set(result) == {"kind", "review_record"}
    assert result["review_record"]["mitigation"]["file_changes"] == [
        {"path": "app.py", "status": "deleted"}
    ]
    assert default_artifact_result_exists


@pytest.mark.asyncio
async def test_single_agent_activity_result_restores_model_before_public_projection() -> (
    None
):
    """The registered activity return type must restore the full fix outcome."""
    from temporalio import activity
    from temporalio.contrib.pydantic import pydantic_data_converter

    from sec_review_agents.review_stages.single_agent.result import (
        SingleAgentFixOutcome,
        build_single_agent_fix_outcome,
    )
    from sec_review_agents.workflows.issue.single_agent import (
        build_issue_single_agent_review_record,
        run_issue_single_agent_activity,
    )

    outcome = build_single_agent_fix_outcome(
        overview="Removed unsafe entrypoint",
        verdict="confirmed-defect",
        validation_level="static",
        regression_status="not-run",
        target_claim="Unsafe entrypoint",
        file_changes=[{"path": "unsafe.py", "status": "deleted"}],
        patch_diff="reference patch",
        self_check_notes=["Checked callers"],
    )
    definition = activity._Definition.must_from_callable(
        run_issue_single_agent_activity
    )
    assert definition.ret_type is SingleAgentFixOutcome
    restored = (
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([outcome]), [definition.ret_type]
        )
    )[0]
    assert isinstance(restored, SingleAgentFixOutcome)
    assert restored == outcome
    public = build_issue_single_agent_review_record(single_agent_result=restored)
    assert public["mitigation"]["file_changes"] == outcome.file_changes
    assert public["verification"]["verification_findings"] == ["Checked callers"]
