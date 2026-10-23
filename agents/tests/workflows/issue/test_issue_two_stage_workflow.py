from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.workflows.issue.two_stage import execute_issue_two_stage


@pytest.mark.asyncio
async def test_two_stage_workflow_runs_internal_self_check_mitigation_without_verifier(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local-root"
    input_data: dict[str, Any] = {
        "run_id": "run-two-stage",
        "issue": {},
        "input_bundle_root_path": str(local_root),
        "artifact_paths": {
            "analyzer": str(tmp_path / "analyzer"),
            "mitigator": str(tmp_path / "mitigator"),
        },
    }
    analysis_result = {
        "verdict": "confirmed-vulnerability",
        "narratives": [{"verdict": "confirmed-vulnerability"}],
    }
    mitigation_result = {
        "overview": "applied",
        "file_changes": [{"path": "demo.py", "status": "deleted"}],
        "residual_risks": [],
    }

    with (
        patch(
            "sec_review_agents.workflows.issue.analysis.analyze_issue",
            return_value=analysis_result,
        ),
        patch(
            "sec_review_agents.workflows.issue.mitigation_self_check.mitigate_issue_with_self_check",
            return_value=mitigation_result,
        ) as mitigate_mock,
    ):
        result = await execute_issue_two_stage(
            issue=input_data["issue"],
            workspace_snapshot_tar_path=Path(input_data["input_bundle_root_path"])
            / "workspace.snapshot.tar",
            history_path=Path(input_data["input_bundle_root_path"]) / "history",
            analyzer_artifacts_path=input_data["artifact_paths"]["analyzer"],
            mitigator_artifacts_path=input_data["artifact_paths"]["mitigator"],
            review_objective="audit",
            test_changes="deny",
        )

    mitigate_mock.assert_called_once()
    assert mitigate_mock.call_args.kwargs["test_changes"] == "deny"
    assert set(result) == {"kind", "review_record"}
    assert result["kind"] == "issue-two-stage-strategy-result"
    review_record = result["review_record"]
    assert set(review_record) == {"analysis", "mitigation", "verification", "cvss"}
    assert review_record["mitigation"]["file_changes"] == [
        {"path": "demo.py", "status": "deleted"}
    ]
    assert review_record["analysis"]["verdict"] == "confirmed-vulnerability"
    assert review_record["verification"]["patch_coverage"] is None


@pytest.mark.asyncio
async def test_two_stage_workflow_raises_self_check_errors(tmp_path: Path) -> None:
    input_data: dict[str, Any] = {
        "run_id": "run-self-check-error",
        "issue": {},
        "artifact_paths": {
            "analyzer": str(tmp_path / "analyzer"),
            "mitigator": str(tmp_path / "mitigator"),
        },
        "input_bundle_root_path": str(tmp_path / "local-self-check-error"),
    }
    analysis_result = {
        "verdict": "confirmed-vulnerability",
        "narratives": [{"verdict": "confirmed-vulnerability"}],
    }

    with (
        patch(
            "sec_review_agents.workflows.issue.analysis.analyze_issue",
            return_value=analysis_result,
        ),
        patch(
            "sec_review_agents.workflows.issue.mitigation_self_check.mitigate_issue_with_self_check",
            side_effect=RuntimeError("real mitigator error"),
        ),
        pytest.raises(RuntimeError, match="real mitigator error"),
    ):
        await execute_issue_two_stage(
            issue=input_data["issue"],
            workspace_snapshot_tar_path=Path(input_data["input_bundle_root_path"])
            / "workspace.snapshot.tar",
            history_path=Path(input_data["input_bundle_root_path"]) / "history",
            analyzer_artifacts_path=input_data["artifact_paths"]["analyzer"],
            mitigator_artifacts_path=input_data["artifact_paths"]["mitigator"],
            review_objective="audit",
        )


@pytest.mark.asyncio
async def test_two_stage_threads_setup_declaration_to_both_stages(
    tmp_path: Path,
) -> None:
    """The ablation path must run the declaration for the analyzer *and* the
    mitigator, like the default and single-agent strategies do. The mitigator
    previously ignored it."""
    analysis_result = {
        "verdict": "confirmed-vulnerability",
        "narratives": [{"verdict": "confirmed-vulnerability"}],
    }
    mitigation_result = {
        "overview": "applied",
        "changed_files": ["demo.py"],
        "residual_risks": [],
    }

    with (
        patch(
            "sec_review_agents.workflows.issue.analysis.analyze_issue",
            return_value=analysis_result,
        ) as analyze_mock,
        patch(
            "sec_review_agents.workflows.issue.mitigation_self_check.mitigate_issue_with_self_check",
            return_value=mitigation_result,
        ) as mitigate_mock,
    ):
        await execute_issue_two_stage(
            issue={},
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history",
            analyzer_artifacts_path=tmp_path / "analyzer",
            mitigator_artifacts_path=tmp_path / "mitigator",
            review_objective="audit",
            setup_declaration_content="setup:\n  - run: echo hi\n",
        )

    assert analyze_mock.call_args.kwargs["setup_declaration_content"] == (
        "setup:\n  - run: echo hi\n"
    )
    assert mitigate_mock.call_args.kwargs["setup_declaration_content"] == (
        "setup:\n  - run: echo hi\n"
    )


@pytest.mark.asyncio
async def test_two_stage_repair_objective_skips_mitigation_without_confirmed_narrative(
    tmp_path: Path,
) -> None:
    """A trusted `repair` input does not force mitigation past the analyzer's verdict.

    PatchEval sends `repair` for a known CVE. When the analyzer still cannot confirm a
    narrative, forcing a repair would invent a patch; the stage must stay skipped.
    """
    analysis_result = {"verdict": "no-actionable-finding", "narratives": []}

    with (
        patch(
            "sec_review_agents.workflows.issue.analysis.analyze_issue",
            return_value=analysis_result,
        ) as analyze_mock,
        patch(
            "sec_review_agents.workflows.issue.mitigation_self_check.mitigate_issue_with_self_check",
        ) as mitigate_mock,
    ):
        result = await execute_issue_two_stage(
            issue={},
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history",
            analyzer_artifacts_path=tmp_path / "analyzer",
            mitigator_artifacts_path=tmp_path / "mitigator",
            review_objective="repair",
        )

    assert analyze_mock.call_args.kwargs["review_objective"] == "repair"
    mitigate_mock.assert_not_called()
    assert result["review_record"]["mitigation"]["file_changes"] == []
