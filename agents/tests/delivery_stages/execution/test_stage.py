from unittest.mock import AsyncMock, patch

import pytest

from sec_review_agents.delivery_stages.execution.stage import execute_delivery_entry


def _case_result(*, file_changes: list[dict]) -> dict:
    return {
        "case_id": "case-1",
        "analyzer_overview": "analysis",
        "analyzer_verdict": "confirmed",
        "mitigator_file_changes": file_changes,
        "mitigator_patch_diff": "patch",
        "verifier_overview": "verified",
        "verifier_coverage": None,
        "verifier_patch_findings": [],
        "verifier_findings": [],
        "residual_risks": [],
    }


@pytest.mark.asyncio
async def test_single_execution_classifies_empty_file_changes(tmp_path) -> None:
    """Do not publish a single delivery whose mitigation produced no files."""
    result = await execute_delivery_entry(
        run_artifacts_root=tmp_path,
        delivery_entry={
            "delivery_id": "delivery-1",
            "strategy": "single",
            "case_ids": ["case-1"],
            "reason": "independent case",
        },
        case_results=[_case_result(file_changes=[])],
    )

    assert result == {
        "delivery_id": "delivery-1",
        "status": "no-changes",
        "error": "Single delivery has no file changes.",
        "patch_diff": "patch",
        "file_changes": [],
    }


@pytest.mark.asyncio
async def test_combined_execution_builds_status_from_patch_artifact(tmp_path) -> None:
    """Keep delivery status ownership in execution rather than patch synthesis."""
    file_changes = [
        {
            "path": "src/app.py",
            "status": "upsert",
            "content": "updated\n",
            "content_encoding": "utf-8",
        }
    ]
    synthesis = AsyncMock(
        return_value={"patch_diff": "combined patch", "file_changes": file_changes}
    )

    with patch(
        "sec_review_agents.delivery_stages.execution.stage."
        "synthesize_combined_delivery_patch",
        synthesis,
    ):
        result = await execute_delivery_entry(
            run_artifacts_root=tmp_path,
            baseline_snapshot_tar_path=tmp_path / "baseline.tar",
            delivery_entry={
                "delivery_id": "delivery-1",
                "strategy": "combined",
                "case_ids": ["case-1"],
                "reason": "overlap",
            },
            case_results=[_case_result(file_changes=file_changes)],
        )

    assert result == {
        "delivery_id": "delivery-1",
        "status": "ready",
        "error": None,
        "patch_diff": "combined patch",
        "file_changes": file_changes,
    }


@pytest.mark.asyncio
async def test_combined_execution_classifies_empty_patch_artifact(tmp_path) -> None:
    synthesis = AsyncMock(return_value={"patch_diff": "", "file_changes": []})

    with patch(
        "sec_review_agents.delivery_stages.execution.stage."
        "synthesize_combined_delivery_patch",
        synthesis,
    ):
        result = await execute_delivery_entry(
            run_artifacts_root=tmp_path,
            baseline_snapshot_tar_path=tmp_path / "baseline.tar",
            delivery_entry={
                "delivery_id": "delivery-1",
                "strategy": "combined",
                "case_ids": ["case-1"],
                "reason": "overlap",
            },
            case_results=[_case_result(file_changes=[])],
        )

    assert result is not None
    assert result["status"] == "no-changes"
    assert result["error"] == "Patch synthesis produced no delivery file changes."


@pytest.mark.asyncio
async def test_combined_execution_converts_synthesis_failure(tmp_path) -> None:
    synthesis = AsyncMock(side_effect=RuntimeError("agent failed"))

    with patch(
        "sec_review_agents.delivery_stages.execution.stage."
        "synthesize_combined_delivery_patch",
        synthesis,
    ):
        result = await execute_delivery_entry(
            run_artifacts_root=tmp_path,
            baseline_snapshot_tar_path=tmp_path / "baseline.tar",
            delivery_entry={
                "delivery_id": "delivery-1",
                "strategy": "combined",
                "case_ids": ["case-1"],
                "reason": "overlap",
            },
            case_results=[_case_result(file_changes=[])],
        )

    assert result is not None
    assert result["status"] == "failed"
    assert result["error"] == "Patch synthesis failed: agent failed"
