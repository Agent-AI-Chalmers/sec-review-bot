from annotationlib import Format, get_annotations
from typing import Any

import pytest

from sec_review_agents.workflows.repository.case_execution_input import (
    prepare_case_execution_input,
)
from sec_review_agents.workflows.repository.workflow import (
    prepare_repository_case_review_inputs_activity,
)
from sec_review_agents.workflows.repository_case.input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository_case.workflow import (
    RepositoryCaseReviewRequest,
    prepare_repository_case_activity,
)
from sec_review_agents.workflows.review_intent import TEST_CHANGES_ALLOW
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


def _prepare_case_execution_input(
    input_data: dict[str, Any],
    case: dict[str, Any],
) -> RepositoryCaseExecutionInput:
    return prepare_case_execution_input(
        workspace_snapshot_tar_path=input_data["workspace_snapshot_tar_path"],
        history_path=input_data["history_path"],
        incremental_window_path=input_data.get("incremental_window_path"),
        scan_mode=input_data["scan_mode"],
        test_changes=(input_data.get("review_intent") or {}).get("test_changes")
        or TEST_CHANGES_ALLOW,
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
        "test_changes",
    }
    assert RepositoryCaseExecutionInput.__optional_keys__ == {
        "setup_declaration_content"
    }


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
    assert case_execution_input["test_changes"] == TEST_CHANGES_ALLOW


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
                "published_trajectories_path": str(tmp_path / "trajectories"),
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


def test_repository_case_activity_preserves_published_trajectories_path(
    tmp_path,
) -> None:
    published_trajectories_path = str(tmp_path / "cases" / "case-1" / "trajectories")

    prepared_case = prepare_repository_case_activity(
        {
            "case_execution_input": {
                "case_id": "case-1",
                "review_input": "Prepared repository case review input.",
                "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
                "history_path": str(tmp_path / "history"),
                "scan_mode": "full",
                "incremental_window_path": None,
                "test_changes": TEST_CHANGES_ALLOW,
            },
            "cases_artifacts_path": str(tmp_path / "cases"),
            "run_id": "run-repo-case",
            "published_trajectories_path": published_trajectories_path,
            "timeout_seconds": 30,
            "runtime_context": {},
        }
    )

    assert prepared_case["published_trajectories_path"] == published_trajectories_path


def test_repository_case_trajectories_are_published_under_the_case_root(
    tmp_path,
) -> None:
    """Case-owned trajectories let only a completed case register its own extraction."""
    cases_root = tmp_path / "artifacts" / "run-1" / "cases"
    request = ReviewWorkflowRequest(
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
                "test_changes": TEST_CHANGES_ALLOW,
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

    assert batch["case_requests"][0]["published_trajectories_path"] == str(
        cases_root / "case-1" / "trajectories"
    )


def test_repository_case_execution_input_flattens_test_changes_when_set(
    tmp_path,
) -> None:
    input_data = {
        "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
        "history_path": str(tmp_path / "history"),
        "scan_mode": "full",
        "review_intent": {"test_changes": "deny"},
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

    assert case_execution_input["test_changes"] == "deny"


def test_repository_case_execution_input_rejects_missing_case_id(tmp_path) -> None:
    with pytest.raises(ValueError, match="Repository case is missing case_id."):
        prepare_case_execution_input(
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history",
            incremental_window_path=None,
            scan_mode="full",
            test_changes=TEST_CHANGES_ALLOW,
            case={
                "case_id": " ",
                "category": "demo",
                "summary": "Demo case",
                "evidence": [],
                "anchor_locations": [],
                "member_candidate_ids": ["cand-1"],
            },
        )


@pytest.mark.asyncio
async def test_prepared_case_survives_temporal_payload_round_trip(tmp_path) -> None:
    """Internal type declarations must retain the dictionary wire format and reviewInput isolation."""
    from temporalio.converter import DataConverter

    from sec_review_agents.workflows.repository_case.input import PreparedRepositoryCase

    execution_input = prepare_case_execution_input(
        workspace_snapshot_tar_path=tmp_path / "workspace.tar",
        history_path=tmp_path / "history",
        incremental_window_path=None,
        scan_mode="full",
        test_changes=TEST_CHANGES_ALLOW,
        case={
            "case_id": "case-1",
            "category": "access-control",
            "summary": "Review authorization.",
            "evidence": [],
            "anchor_locations": [],
            "member_candidate_ids": ["private-triage-id"],
        },
    )
    prepared = prepare_repository_case_activity(
        {
            "run_id": "run-1",
            "case_execution_input": execution_input,
            "cases_artifacts_path": str(tmp_path / "cases"),
            "published_trajectories_path": str(tmp_path / "trajectories"),
            "timeout_seconds": 30,
            "runtime_context": {},
        }
    )
    converter = DataConverter.default
    payloads = await converter.encode([prepared])
    untyped = (await converter.decode(payloads))[0]
    typed = (await converter.decode(payloads, [PreparedRepositoryCase]))[0]
    assert typed == untyped == prepared
    assert typed["case_execution_input"] == execution_input
    assert "member_candidate_ids" not in typed["case_execution_input"]
    assert "case" not in typed["case_execution_input"]
    assert typed["artifact_paths"] == {
        name: str(tmp_path / "cases" / "case-1" / name)
        for name in ("analyzer", "cvss", "mitigator", "verifier")
    }


@pytest.fixture
def case_review_request(tmp_path) -> RepositoryCaseReviewRequest:
    return {
        "run_id": "run-1",
        "case_execution_input": {
            "case_id": "case-1",
            "review_input": "Review authorization.",
            "workspace_snapshot_tar_path": str(tmp_path / "workspace.tar"),
            "history_path": str(tmp_path / "history"),
            "scan_mode": "full",
            "incremental_window_path": None,
            "test_changes": "allow",
        },
        "cases_artifacts_path": str(tmp_path / "cases"),
        "published_trajectories_path": str(tmp_path / "trajectories"),
        "timeout_seconds": 30,
        "runtime_context": {},
    }


@pytest.mark.parametrize("value", [None, "", " \n ", "/tmp/window"])
def test_case_preparation_normalizes_optional_values_without_mutating_request(
    case_review_request: RepositoryCaseReviewRequest, value: str | None
) -> None:
    source = case_review_request["case_execution_input"]
    source["incremental_window_path"] = value
    source["setup_declaration_content"] = value
    prepared = prepare_repository_case_activity(case_review_request)
    expected = value if value and value.strip() else None
    assert prepared["case_execution_input"]["incremental_window_path"] == expected
    assert prepared["case_execution_input"].get("setup_declaration_content") == expected
    assert source["incremental_window_path"] == value
    assert source["setup_declaration_content"] == value


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("workspace_snapshot_tar_path", " "),
        ("history_path", ""),
        ("history_path", None),
        ("incremental_window_path", 42),
        ("setup_declaration_content", {}),
        ("test_changes", "unknown"),
        ("scan_mode", "unknown"),
    ],
)
def test_case_preparation_rejects_invalid_fields_before_stages(
    case_review_request: RepositoryCaseReviewRequest, field: str, value: Any
) -> None:
    """Malformed serialized inputs must fail before stages rely on their types."""
    malformed: Any = case_review_request["case_execution_input"]
    malformed[field] = value
    with pytest.raises(ValueError, match=field):
        prepare_repository_case_activity(case_review_request)
