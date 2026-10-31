"""Prepared inputs retain their variant and invariants across Temporal payloads."""

import pytest
from pydantic import ValidationError
from temporalio.contrib.pydantic import pydantic_data_converter

from sec_review_agents.scan_stages.input import (
    RepositoryChangedFile,
    RepositoryScanScope,
)
from sec_review_agents.workflows.review_intent import ReviewIntent
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.prepared_input_fixtures import (
    prepared_issue_input,
    prepared_pull_request_input,
    prepared_repository_input,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "prepared",
    [
        prepared_issue_input(),
        prepared_pull_request_input(),
        prepared_repository_input(),
        prepared_repository_input(
            scan_mode="incremental",
            base_sha="base",
            head_sha="head",
            incremental_window_path="/tmp/window.json",
        ),
    ],
)
async def test_temporal_request_restores_prepared_variant(prepared):
    request = ReviewWorkflowRequest(
        workflow=prepared.workflow,
        run_id="prepared-roundtrip",
        prepared_input=prepared,
        timeout_seconds=30,
        runtime_context={},
    )
    (restored,) = await pydantic_data_converter.decode(
        await pydantic_data_converter.encode([request]), [ReviewWorkflowRequest]
    )
    assert restored == request
    assert type(restored.prepared_input) is type(prepared)
    assert isinstance(restored.prepared_input.review_intent, ReviewIntent)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "factory,missing",
    [
        (prepared_issue_input, "issue"),
        (prepared_pull_request_input, "incremental_window_path"),
        (prepared_repository_input, "scan_mode"),
    ],
)
async def test_temporal_request_rejects_missing_variant_fields(factory, missing):
    prepared = factory()
    payload = {
        "workflow": prepared.workflow,
        "run_id": "prepared-invalid",
        "prepared_input": prepared.model_dump(mode="json"),
        "timeout_seconds": 30,
        "runtime_context": {},
    }
    del payload["prepared_input"][missing]
    with pytest.raises(ValidationError):
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([payload]), [ReviewWorkflowRequest]
        )


@pytest.mark.parametrize("field", ["base_sha", "head_sha", "incremental_window_path"])
def test_incremental_input_rejects_blank_required_control(field):
    fields = {
        "scan_mode": "incremental",
        "base_sha": "base",
        "head_sha": "head",
        "incremental_window_path": "/tmp/window.json",
    }
    fields[field] = "  "
    with pytest.raises(ValidationError):
        prepared_repository_input(**fields)


@pytest.mark.parametrize(
    "factory,field",
    [
        (prepared_issue_input, "analyzer_artifacts_path"),
        (prepared_pull_request_input, "incremental_window_path"),
        (prepared_repository_input, "cases_artifacts_path"),
    ],
)
def test_prepared_input_rejects_blank_worker_path(factory, field):
    with pytest.raises(ValidationError):
        factory(**{field: "  "})


@pytest.mark.asyncio
async def test_temporal_request_restores_nested_scan_scope():
    scope = RepositoryScanScope.model_validate(
        {
            "paths_ignore": ["vendor/**"],
            "incremental_changed_files": [
                {"path": " src\\gone.py ", "status": "deleted", "previous_path": None}
            ],
        }
    )
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="scope-roundtrip",
        prepared_input=prepared_repository_input(scan_scope=scope),
        timeout_seconds=30,
        runtime_context={},
    )
    (restored,) = await pydantic_data_converter.decode(
        await pydantic_data_converter.encode([request]), [ReviewWorkflowRequest]
    )
    assert restored == request
    assert isinstance(restored.prepared_input.scan_scope, RepositoryScanScope)
    item = restored.prepared_input.scan_scope.incremental_changed_files[0]
    assert isinstance(item, RepositoryChangedFile)
    assert item.path == " src\\gone.py "


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing",
    ["paths_ignore", "incremental_changed_files", "path", "status", "previous_path"],
)
async def test_temporal_request_rejects_missing_scan_scope_fields(missing):
    scope = {
        "paths_ignore": [],
        "incremental_changed_files": [
            {"path": "src/a.py", "status": "modified", "previous_path": None}
        ],
    }
    if missing in {"paths_ignore", "incremental_changed_files"}:
        del scope[missing]
    else:
        del scope["incremental_changed_files"][0][missing]
    prepared = prepared_repository_input().model_dump(mode="json")
    prepared["scan_scope"] = scope
    payload = {
        "workflow": "repository-review",
        "run_id": "invalid-scope",
        "prepared_input": prepared,
        "timeout_seconds": 30,
        "runtime_context": {},
    }
    with pytest.raises(ValidationError):
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([payload]), [ReviewWorkflowRequest]
        )


@pytest.mark.parametrize("status", ["removed", "unknown", "DELETED", " deleted "])
def test_scan_scope_rejects_status_outside_public_vocabulary(status):
    with pytest.raises(ValidationError):
        prepared_repository_input(
            scan_scope={
                "paths_ignore": [],
                "incremental_changed_files": [
                    {"path": "gone.py", "status": status, "previous_path": None}
                ],
            }
        )


def test_scan_scope_does_not_strengthen_previous_path_string_validation():
    """The public schema permits whitespace in renamed/copied previous_path."""
    scope = RepositoryScanScope.model_validate(
        {
            "paths_ignore": [],
            "incremental_changed_files": [
                {"path": "new.py", "status": "renamed", "previous_path": " "}
            ],
        }
    )
    assert scope.incremental_changed_files[0].previous_path == " "
