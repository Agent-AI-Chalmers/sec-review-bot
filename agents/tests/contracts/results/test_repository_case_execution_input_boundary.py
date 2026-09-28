from annotationlib import Format, get_annotations
from typing import Any

import pytest

from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.repository.case_execution_input import (
    RepositoryCaseExecutionInput,
    prepare_case_execution_input,
)
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseReviewRequest,
    prepare_repository_case_activity,
    prepare_repository_case_review_inputs_activity,
)
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED


def _prepare_case_execution_input(
    input_data: dict[str, Any],
    case: dict[str, Any],
) -> RepositoryCaseExecutionInput:
    return prepare_case_execution_input(
        workspace_snapshot_tar_path=input_data["workspace_snapshot_tar_path"],
        history_path=input_data["history_path"],
        incremental_window_path=input_data.get("incremental_window_path"),
        scan_mode=input_data["scan_mode"],
        repair_mode=(input_data.get("review_intent") or {}).get("repair_mode")
        or REPAIR_MODE_TEST_CHANGES_ALLOWED,
        case=case,
    )


def test_repository_case_temporal_request_timeout_is_required_integer() -> None:
    assert (
        get_annotations(RepositoryCaseReviewRequest, format=Format.VALUE)[
            "timeout_seconds"
        ]
        is int
    )
    assert (
        get_annotations(RepositoryCaseReviewRequest, format=Format.VALUE)[
            "case_execution_input"
        ]
        is RepositoryCaseExecutionInput
    )


def test_repository_case_execution_input_tracks_required_and_optional_fields() -> None:
    assert RepositoryCaseExecutionInput.__required_keys__ == {
        "case_id",
        "review_input",
        "workspace_snapshot_tar_path",
        "history_path",
        "scan_mode",
        "incremental_window_path",
        "repair_mode",
    }
    assert RepositoryCaseExecutionInput.__optional_keys__ == set()


def test_repository_case_execution_input_carries_case_id_and_prepared_review_input(
    tmp_path,
) -> None:
    input_data = {
        "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
        "history_path": str(tmp_path / "history"),
        "scan_mode": "full",
        "artifact_paths": {"cases": str(tmp_path / "cases")},
    }
    case = {
        "case_id": "case-1",
        "category": "demo",
        "summary": "Demo case",
        "evidence": ["src/app.py reaches a dangerous sink"],
        "anchor_locations": [],
        "member_candidate_ids": ["cand-1"],
    }

    case_execution_input = _prepare_case_execution_input(input_data, case)

    assert case_execution_input["case_id"] == "case-1"
    assert "case" not in case_execution_input
    assert "Demo case" in case_execution_input["review_input"]
    assert case_execution_input["incremental_window_path"] is None
    assert case_execution_input["repair_mode"] == REPAIR_MODE_TEST_CHANGES_ALLOWED


@pytest.mark.parametrize(
    ("case_execution_input", "message"),
    [
        (
            {"review_input": "Prepared input."},
            "Repository case execution input is missing case_id.",
        ),
        (
            {"case_id": "case-1"},
            "Repository case execution input for case-1 is missing review_input.",
        ),
    ],
)
def test_repository_case_execution_rejects_invalid_case_identity(
    case_execution_input: dict,
    message: str,
    tmp_path,
) -> None:
    with pytest.raises(ValueError, match=message):
        prepare_repository_case_activity(
            {
                "run_id": "run-repo-case",
                "case_execution_input": case_execution_input,  # type: ignore[typeddict-item]  # intentionally invalid case payload
                "cases_artifacts_path": str(tmp_path / "cases"),
                "published_transcripts_path": str(tmp_path / "transcripts"),
                "timeout_seconds": 30,
                "runtime_context": {},
            }
        )


def test_repository_case_execution_input_does_not_carry_stage_artifact_paths(
    tmp_path,
) -> None:
    input_data = {
        "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
        "history_path": str(tmp_path / "history"),
        "scan_mode": "full",
        "artifact_paths": {"cases": str(tmp_path / "cases")},
    }
    case = {
        "case_id": "case-1",
        "category": "demo",
        "summary": "Demo case",
        "evidence": [],
        "anchor_locations": [],
        "member_candidate_ids": ["cand-1"],
    }

    case_execution_input = _prepare_case_execution_input(input_data, case)

    assert "artifact_paths" not in case_execution_input


def test_repository_case_activity_preserves_published_transcripts_path(
    tmp_path,
) -> None:
    published_transcripts_path = str(tmp_path / "cases" / "case-1" / "transcripts")

    prepared_case = prepare_repository_case_activity(
        {
            "case_execution_input": {
                "case_id": "case-1",
                "review_input": "Prepared repository case review input.",
                "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
                "history_path": str(tmp_path / "history"),
                "scan_mode": "full",
                "incremental_window_path": None,
                "repair_mode": REPAIR_MODE_TEST_CHANGES_ALLOWED,
            },
            "cases_artifacts_path": str(tmp_path / "cases"),
            "run_id": "run-repo-case",
            "published_transcripts_path": published_transcripts_path,
            "timeout_seconds": 30,
            "runtime_context": {},
        }
    )

    assert prepared_case["published_transcripts_path"] == published_transcripts_path


def test_repository_case_transcripts_are_published_under_the_case_root(
    tmp_path,
) -> None:
    """Case-owned transcripts let only a completed case register its own extraction."""
    cases_root = tmp_path / "artifacts" / "run-1" / "cases"
    request = InternalWorkflowRequest(
        workflow="repository-review",
        run_id="run-1",
        prepared_input={
            "artifact_root_path": str(tmp_path / "artifacts" / "run-1"),
            "artifact_paths": {"cases": str(cases_root)},
            "bundle_paths": {
                "workspace_snapshot_tar_path": str(tmp_path / "workspace.tar"),
                "history_path": str(tmp_path / "history"),
            },
            "scan_target": {"scan_mode": "full"},
            "review_intent": {
                "objective": "audit",
                "repair_mode": REPAIR_MODE_TEST_CHANGES_ALLOWED,
            },
        },
        timeout_seconds=30,
        runtime_context={},
    )
    case = {
        "case_id": "case-1",
        "category": "demo",
        "summary": "Demo case",
        "evidence": [],
        "anchor_locations": [],
    }

    batch = prepare_repository_case_review_inputs_activity(request, [case])

    assert batch["case_requests"][0]["published_transcripts_path"] == str(
        cases_root / "case-1" / "transcripts"
    )


def test_repository_case_execution_input_flattens_repair_mode_when_set(
    tmp_path,
) -> None:
    input_data = {
        "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
        "history_path": str(tmp_path / "history"),
        "scan_mode": "full",
        "review_intent": {"repair_mode": "no-test-changes"},
        "artifact_paths": {"cases": str(tmp_path / "cases")},
    }
    case = {
        "case_id": "case-1",
        "category": "demo",
        "summary": "Demo case",
        "evidence": [],
        "anchor_locations": [],
        "member_candidate_ids": ["cand-1"],
    }

    case_execution_input = _prepare_case_execution_input(input_data, case)

    assert case_execution_input["repair_mode"] == "no-test-changes"


def test_repository_case_execution_input_rejects_missing_case_id(tmp_path) -> None:
    with pytest.raises(ValueError, match="Repository case is missing case_id."):
        prepare_case_execution_input(
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history",
            incremental_window_path=None,
            scan_mode="full",
            repair_mode=REPAIR_MODE_TEST_CHANGES_ALLOWED,
            case={
                "case_id": " ",
                "category": "demo",
                "summary": "Demo case",
                "evidence": [],
                "anchor_locations": [],
                "member_candidate_ids": ["cand-1"],
            },
        )
