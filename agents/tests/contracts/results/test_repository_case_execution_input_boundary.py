from annotationlib import Format, get_annotations
from typing import Any

import pytest

from sec_review_agents.agents.discovery.model import DiscoveryLocation
from sec_review_agents.scan_stages.input import RepositoryScanScope
from sec_review_agents.scan_stages.triage.result import TriageCase
from sec_review_agents.workflows.prepared_input import PreparedRepositoryInput
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
from sec_review_agents.workflows.review_intent import TEST_CHANGES_ALLOW, ReviewIntent
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.prepared_input_fixtures import prepared_repository_input


def _prepare_case_execution_input(
    input_data: dict[str, Any],
    case: TriageCase,
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
    assert {
        name
        for name, field in RepositoryCaseExecutionInput.model_fields.items()
        if field.is_required()
    } == {
        "case_id",
        "review_input",
        "workspace_snapshot_tar_path",
        "history_path",
        "scan_mode",
        "incremental_window_path",
        "test_changes",
    }
    assert {
        name
        for name, field in RepositoryCaseExecutionInput.model_fields.items()
        if not field.is_required()
    } == {"setup_declaration_content"}


def test_repository_case_execution_input_carries_case_id_and_prepared_review_input(
    tmp_path,
) -> None:
    input_data = {
        "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
        "history_path": str(tmp_path / "history"),
        "scan_mode": "full",
        "artifact_paths": {"cases": str(tmp_path / "cases")},
    }
    case = TriageCase.model_validate(
        {
            "case_id": "case-1",
            "category": "demo",
            "summary": "Demo case",
            "evidence": ["src/app.py reaches a dangerous sink"],
            "anchor_locations": [],
            "member_candidate_ids": ["cand-1"],
        }
    )

    case_execution_input = _prepare_case_execution_input(input_data, case)

    assert case_execution_input.case_id == "case-1"
    assert "case" not in case_execution_input.model_dump()
    assert "Demo case" in case_execution_input.review_input
    assert case_execution_input.incremental_window_path is None
    assert case_execution_input.test_changes == TEST_CHANGES_ALLOW


@pytest.mark.parametrize(
    ("case_execution_input", "message"),
    [
        (
            {"review_input": "Prepared input."},
            "case_id",
        ),
        (
            {"case_id": "case-1"},
            "review_input",
        ),
    ],
)
def test_repository_case_execution_rejects_invalid_case_identity(
    case_execution_input: dict,
    message: str,
    tmp_path,
) -> None:
    with pytest.raises(ValueError, match=message):
        RepositoryCaseExecutionInput.model_validate(case_execution_input)


def test_repository_case_execution_input_does_not_carry_stage_artifact_paths(
    tmp_path,
) -> None:
    input_data = {
        "workspace_snapshot_tar_path": str(tmp_path / "workspace.snapshot.tar"),
        "history_path": str(tmp_path / "history"),
        "scan_mode": "full",
        "artifact_paths": {"cases": str(tmp_path / "cases")},
    }
    case = TriageCase.model_validate(
        {
            "case_id": "case-1",
            "category": "demo",
            "summary": "Demo case",
            "evidence": [],
            "anchor_locations": [],
            "member_candidate_ids": ["cand-1"],
        }
    )

    case_execution_input = _prepare_case_execution_input(input_data, case)

    assert "artifact_paths" not in case_execution_input.model_dump()


def test_repository_case_activity_preserves_published_trajectories_path(
    tmp_path,
) -> None:
    published_trajectories_path = str(tmp_path / "cases" / "case-1" / "trajectories")

    prepared_case = prepare_repository_case_activity(
        RepositoryCaseReviewRequest.model_validate(
            {
                "case_execution_input": RepositoryCaseExecutionInput.model_validate(
                    {
                        "case_id": "case-1",
                        "review_input": "Prepared repository case review input.",
                        "workspace_snapshot_tar_path": str(
                            tmp_path / "workspace.snapshot.tar"
                        ),
                        "history_path": str(tmp_path / "history"),
                        "scan_mode": "full",
                        "incremental_window_path": None,
                        "test_changes": TEST_CHANGES_ALLOW,
                    }
                ),
                "cases_artifacts_path": str(tmp_path / "cases"),
                "run_id": "run-repo-case",
                "published_trajectories_path": published_trajectories_path,
                "timeout_seconds": 30,
                "runtime_context": {},
            }
        )
    )

    assert prepared_case.published_trajectories_path == published_trajectories_path


def test_repository_case_trajectories_are_published_under_the_case_root(
    tmp_path,
) -> None:
    """Case-owned trajectories let only a completed case register its own extraction."""
    cases_root = tmp_path / "artifacts" / "run-1" / "cases"
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="run-1",
        prepared_input=prepared_repository_input(
            artifact_root_path=str(tmp_path / "artifacts" / "run-1"),
            cases_artifacts_path=str(cases_root),
            workspace_snapshot_tar_path=str(tmp_path / "workspace.tar"),
            history_path=str(tmp_path / "history"),
            scan_mode="full",
            review_intent=ReviewIntent(
                objective="audit", test_changes=TEST_CHANGES_ALLOW
            ),
        ),
        timeout_seconds=30,
        runtime_context={},
    )
    case = TriageCase.model_validate(
        {
            "case_id": "case-1",
            "category": "demo",
            "summary": "Demo case",
            "evidence": [],
            "anchor_locations": [],
            "member_candidate_ids": [],
        }
    )

    batch = prepare_repository_case_review_inputs_activity(request, [case])

    assert batch.case_requests[0].published_trajectories_path == str(
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
    case = TriageCase.model_validate(
        {
            "case_id": "case-1",
            "category": "demo",
            "summary": "Demo case",
            "evidence": [],
            "anchor_locations": [],
            "member_candidate_ids": ["cand-1"],
        }
    )

    case_execution_input = _prepare_case_execution_input(input_data, case)

    assert case_execution_input.test_changes == "deny"


def test_repository_case_execution_input_rejects_missing_case_id(tmp_path) -> None:
    with pytest.raises(ValueError, match="Repository case is missing case_id."):
        prepare_case_execution_input(
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history",
            incremental_window_path=None,
            scan_mode="full",
            test_changes=TEST_CHANGES_ALLOW,
            case=TriageCase.model_validate(
                {
                    "case_id": " ",
                    "category": "demo",
                    "summary": "Demo case",
                    "evidence": [],
                    "anchor_locations": [],
                    "member_candidate_ids": ["cand-1"],
                }
            ),
        )


@pytest.mark.asyncio
async def test_prepared_case_survives_temporal_payload_round_trip(tmp_path) -> None:
    """Restore the prepared model while preserving JSON wire shape and reviewInput isolation."""
    from temporalio.contrib.pydantic import pydantic_data_converter

    from sec_review_agents.workflows.repository_case.input import PreparedRepositoryCase

    execution_input = prepare_case_execution_input(
        workspace_snapshot_tar_path=tmp_path / "workspace.tar",
        history_path=tmp_path / "history",
        incremental_window_path=None,
        scan_mode="full",
        test_changes=TEST_CHANGES_ALLOW,
        case=TriageCase.model_validate(
            {
                "case_id": "case-1",
                "category": "access-control",
                "summary": "Review authorization.",
                "evidence": [],
                "anchor_locations": [],
                "member_candidate_ids": ["private-triage-id"],
            }
        ),
    )
    prepared = prepare_repository_case_activity(
        RepositoryCaseReviewRequest.model_validate(
            {
                "run_id": "run-1",
                "case_execution_input": execution_input,
                "cases_artifacts_path": str(tmp_path / "cases"),
                "published_trajectories_path": str(tmp_path / "trajectories"),
                "timeout_seconds": 30,
                "runtime_context": {},
            }
        )
    )
    converter = pydantic_data_converter
    payloads = await converter.encode([prepared])
    untyped = (await converter.decode(payloads))[0]
    typed = (await converter.decode(payloads, [PreparedRepositoryCase]))[0]
    assert typed == prepared
    assert untyped["case_execution_input"] == execution_input.model_dump()
    assert typed.case_execution_input == execution_input
    assert "member_candidate_ids" not in typed.case_execution_input.model_dump()
    assert "case" not in typed.case_execution_input.model_dump()
    assert typed.artifact_paths.model_dump() == {
        name: str(tmp_path / "cases" / "case-1" / name)
        for name in ("analyzer", "cvss", "mitigator", "verifier")
    }
    malformed = prepared.model_dump(mode="json")
    del malformed["artifact_paths"]["verifier"]
    with pytest.raises(ValueError, match="verifier"):
        await converter.decode(
            await converter.encode([malformed]), [PreparedRepositoryCase]
        )


@pytest.fixture
def case_review_request(tmp_path) -> RepositoryCaseReviewRequest:
    return RepositoryCaseReviewRequest.model_validate(
        {
            "run_id": "run-1",
            "case_execution_input": RepositoryCaseExecutionInput.model_validate(
                {
                    "case_id": "case-1",
                    "review_input": "Review authorization.",
                    "workspace_snapshot_tar_path": str(tmp_path / "workspace.tar"),
                    "history_path": str(tmp_path / "history"),
                    "scan_mode": "full",
                    "incremental_window_path": None,
                    "test_changes": "allow",
                }
            ),
            "cases_artifacts_path": str(tmp_path / "cases"),
            "published_trajectories_path": str(tmp_path / "trajectories"),
            "timeout_seconds": 30,
            "runtime_context": {},
        }
    )


@pytest.mark.parametrize(
    "value", [None, "", " \n ", "/tmp/window", " \nnonblank content\n "]
)
def test_case_input_normalizes_optional_values_without_mutating_source(
    case_review_request: RepositoryCaseReviewRequest, value: str | None
) -> None:
    source = case_review_request.case_execution_input.model_dump()
    source["incremental_window_path"] = value
    source["setup_declaration_content"] = value
    normalized = RepositoryCaseExecutionInput.model_validate(source)
    expected = value if value and value.strip() else None
    assert normalized.incremental_window_path == expected
    assert normalized.setup_declaration_content == expected
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
    malformed = case_review_request.case_execution_input.model_dump()
    malformed[field] = value
    with pytest.raises(ValueError, match=field):
        RepositoryCaseExecutionInput.model_validate(malformed)


def test_case_input_validation_preserves_nonblank_prompt_and_paths(
    case_review_request: RepositoryCaseReviewRequest,
) -> None:
    """Validation must not rewrite prepared prompt formatting or literal file paths."""
    source = case_review_request.case_execution_input.model_dump()
    source.update(
        review_input="  # Review brief\n\nKeep this formatting.\n",
        workspace_snapshot_tar_path=" /tmp/workspace.tar ",
        history_path=" /tmp/history ",
    )
    result = RepositoryCaseExecutionInput.model_validate(source)
    assert result.review_input == source["review_input"]
    assert result.workspace_snapshot_tar_path == source["workspace_snapshot_tar_path"]
    assert result.history_path == source["history_path"]


@pytest.mark.parametrize("timeout", [True, False, 0, -1, 1.5, "30", None])
def test_case_request_requires_strict_positive_timeout(
    case_review_request: RepositoryCaseReviewRequest, timeout: Any
) -> None:
    payload = case_review_request.model_dump()
    payload["timeout_seconds"] = timeout
    with pytest.raises(ValueError, match="timeout_seconds"):
        RepositoryCaseReviewRequest.model_validate(payload)


@pytest.mark.asyncio
async def test_case_request_temporal_round_trip_preserves_runtime_and_input(
    case_review_request: RepositoryCaseReviewRequest,
) -> None:
    from temporalio.contrib.pydantic import pydantic_data_converter

    payload = case_review_request.model_dump()
    payload["runtime_context"] = {"workspace_image": "example:tag"}
    request = RepositoryCaseReviewRequest.model_validate(payload)
    restored = (
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([request]),
            [RepositoryCaseReviewRequest],
        )
    )[0]
    assert restored == request
    assert isinstance(restored.case_execution_input, RepositoryCaseExecutionInput)
    assert restored.runtime_context == {"workspace_image": "example:tag"}


@pytest.mark.asyncio
async def test_case_batch_preserves_requests_and_rejects_invalid_scheduling_limit(
    case_review_request: RepositoryCaseReviewRequest,
) -> None:
    from temporalio.contrib.pydantic import pydantic_data_converter

    from sec_review_agents.workflows.repository.workflow import (
        RepositoryCaseRequestBatch,
    )

    batch = RepositoryCaseRequestBatch(
        max_concurrency=2, case_requests=[case_review_request]
    )
    restored = (
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([batch]), [RepositoryCaseRequestBatch]
        )
    )[0]
    assert restored == batch
    assert isinstance(restored.case_requests[0], RepositoryCaseReviewRequest)
    for invalid in [0, -1, True, "2"]:
        payload = {**batch.model_dump(), "max_concurrency": invalid}
        with pytest.raises(ValueError, match="max_concurrency"):
            await pydantic_data_converter.decode(
                await pydantic_data_converter.encode([payload]),
                [RepositoryCaseRequestBatch],
            )


@pytest.mark.asyncio
async def test_triage_cases_round_trip_into_repository_preparation(tmp_path) -> None:
    """Temporal restores typed triage cases before repository compiles reviewInput."""
    from temporalio.contrib.pydantic import pydantic_data_converter

    from sec_review_agents.workflows.repository.case_execution_input import (
        deleted_repository_cases,
    )

    case = TriageCase(
        case_id="case-1",
        category="access-control",
        summary="Check authorization.",
        evidence=["A route calls a shared guard."],
        anchor_locations=[
            DiscoveryLocation(file="src/routes.py", line=7, label="route"),
            DiscoveryLocation(file="src/guard.py", label="guard"),
        ],
        member_candidate_ids=["candidate-private"],
    )
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="run-1",
        prepared_input=prepared_repository_input(
            cases_artifacts_path=str(tmp_path / "cases"),
            workspace_snapshot_tar_path=str(tmp_path / "workspace.tar"),
            history_path=str(tmp_path / "history"),
            incremental_window_path=str(tmp_path / "window"),
            scan_mode="incremental",
            base_sha="base",
            head_sha="head",
            scan_scope=RepositoryScanScope.model_validate(
                {
                    "paths_ignore": [],
                    "incremental_changed_files": [
                        {
                            "path": "src/guard.py",
                            "status": "deleted",
                            "previous_path": None,
                        }
                    ],
                }
            ),
            review_intent=ReviewIntent(objective="audit", test_changes="allow"),
        ),
        timeout_seconds=30,
        runtime_context={},
    )
    argument_types = get_annotations(
        prepare_repository_case_review_inputs_activity, format=Format.VALUE
    )
    restored_request, restored_cases = await pydantic_data_converter.decode(
        await pydantic_data_converter.encode([request, [case]]),
        [argument_types["request"], argument_types["cases"]],
    )
    assert isinstance(restored_cases[0], TriageCase)
    assert isinstance(restored_cases[0].anchor_locations[0], DiscoveryLocation)
    assert restored_cases[0].anchor_locations[1].line is None
    direct = prepare_repository_case_review_inputs_activity(request, [case])
    restored = prepare_repository_case_review_inputs_activity(
        restored_request, restored_cases
    )
    assert restored == direct
    assert len(restored.case_requests) == 2
    first, deleted = [item.case_execution_input for item in restored.case_requests]
    assert "candidate-private" not in first.review_input
    assert "src/routes.py:7" in first.review_input
    assert "src/guard.py" in deleted.review_input
    assert "Candidate Anchors" not in deleted.review_input
    assert isinstance(request.prepared_input, PreparedRepositoryInput)
    assert (
        deleted.case_id
        == deleted_repository_cases(
            scan_scope=request.prepared_input.scan_scope,
            base_sha="base",
            head_sha="head",
        )[0].case_id
    )
    for missing in ("case_id", "evidence", "anchor_locations"):
        malformed = case.model_dump()
        del malformed[missing]
        with pytest.raises(ValueError, match=missing):
            await pydantic_data_converter.decode(
                await pydantic_data_converter.encode([[malformed]]),
                [argument_types["cases"]],
            )
    for colliding_id in ("case-1", " case-1 ", deleted.case_id):
        with pytest.raises(ValueError, match="must be unique"):
            prepare_repository_case_review_inputs_activity(
                request, [case, case.model_copy(update={"case_id": colliding_id})]
            )
