from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import WorkflowExecutionStatus
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.runner.service.temporal_execution import (
    TemporalRunnerExecutionBackend,
    _record_from_handle,
)
from sec_review_agents.runner.service.workflow import (
    RunnerExecutionRequest,
    RunnerExecutionWorkflow,
    prepare_runner_run_activity,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.issue.single_agent import IssueSingleAgentWorkflow
from sec_review_agents.workflows.issue.two_stage import IssueTwoStageWorkflow
from sec_review_agents.workflows.issue.workflow import IssueReviewWorkflow
from sec_review_agents.workflows.pull_request.workflow import PullRequestReviewWorkflow
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseProcessingWorkflow,
    RepositoryCaseReviewWorkflow,
    RepositoryDeliveryWorkflow,
    RepositoryDiscoveryWorkflow,
    RepositoryReviewWorkflow,
    RepositoryScanWorkflow,
)
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED
from tests.temporal_test_utils import temporal_time_skipping_environment


def _repository_case_execution_input(case_id: str) -> dict:
    return {
        "case_id": case_id,
        "review_input": f"Prepared {case_id} review input.",
        "workspace_snapshot_tar_path": "/tmp/workspace.snapshot.tar",
        "history_path": "/tmp/history",
        "scan_mode": "full",
        "incremental_window_path": None,
        "repair_mode": REPAIR_MODE_TEST_CHANGES_ALLOWED,
    }


class _CompletedDescription:
    status = WorkflowExecutionStatus.COMPLETED

    async def memo(self) -> dict:
        return {"workflow": "issue-review"}


class _CompletedHandle:
    id = "run-invalid"

    async def describe(self) -> _CompletedDescription:
        return _CompletedDescription()

    async def result(self) -> dict:
        return {"ok": True}


class _MissingStatusDescription:
    status = None

    async def memo(self) -> dict:
        return {"workflow": "issue-review"}


class _MissingStatusHandle:
    id = "run-missing-status"

    async def describe(self) -> _MissingStatusDescription:
        return _MissingStatusDescription()

    async def result(self) -> dict:
        return {"ok": True, "result": {"workflow": "issue-review"}}


class _CompletedNonDictMemoDescription:
    status = WorkflowExecutionStatus.COMPLETED

    async def memo(self) -> str:
        return "not-a-memo"


class _CompletedNonDictMemoHandle:
    id = "run-non-dict-memo"

    async def describe(self) -> _CompletedNonDictMemoDescription:
        return _CompletedNonDictMemoDescription()

    async def result(self) -> dict:
        return {"ok": True, "result": {"workflow": "issue-review"}}


@activity.defn(name="prepare_runner_run_activity")
def fake_prepare_runner_run(request: RunnerExecutionRequest) -> dict:
    return {
        "ok": True,
        "workflow": request.workflow,
        "run_id": request.run_id,
        "prepared_input": {
            "workflow": request.workflow,
        },
        "runtime_context": {},
        "timeout_seconds": request.timeout_seconds,
    }


@activity.defn(name="prepare_runner_run_activity")
def fake_prepare_runner_run_failure(_request: RunnerExecutionRequest) -> dict:
    return {
        "ok": False,
        "error": {
            "category": "input",
            "code": "RUNNER_REQUEST_INVALID",
            "message": "bad input",
            "retryable": False,
            "details": {},
        },
    }


@activity.defn(name="analyze_pull_request_activity")
def fake_analyze_pull_request(
    _prepared_input: dict,
    _runtime_context: dict,
) -> dict:
    return {
        "status": "completed",
        "narratives": [
            {
                "verdict": "confirmed-vulnerability",
            }
        ],
    }


@activity.defn(name="mitigate_pull_request_activity")
def fake_mitigate_pull_request(
    _prepared_input: dict,
    _analysis_result: dict,
    _retry_context: dict | None,
    _runtime_context: dict,
) -> dict:
    return {}


@activity.defn(name="verify_pull_request_activity")
def fake_verify_pull_request(
    _prepared_input: dict,
    _analysis_result: dict,
    _mitigation_result: dict | None,
    _retry_context: dict | None,
    _runtime_context: dict,
) -> dict:
    return {
        "resolution_next_step": "none",
    }


@activity.defn(name="archive_pull_request_feedback_attempt_activity")
def fake_archive_pull_request_feedback_attempt(
    _prepared_input: dict,
    _retry_context: dict,
) -> None:
    return None


@activity.defn(name="build_pull_request_review_result_activity")
def fake_build_pull_request_review_result(
    _analysis_result: dict,
    _mitigation_result: dict | None,
    _verifier_result: dict | None,
) -> dict:
    return {
        "workflow": "pull-request-review",
    }


@activity.defn(name="prepare_internal_workflow_activity")
def fake_prepare_internal_workflow(_workflow_name: str, _run_id: str) -> None:
    return None


@activity.defn(name="build_issue_two_stage_result_activity")
def fake_build_issue_two_stage_result_activity(
    _two_stage_result: dict,
) -> dict:
    return {
        "kind": "issue-two-stage-strategy-result",
        "review_record": {},
    }


@activity.defn(name="mitigate_issue_self_check_activity")
def fake_mitigate_issue_self_check(
    _prepared_input: dict,
    _analysis_result: dict,
    _runtime_context: dict,
) -> dict:
    return {}


@activity.defn(name="run_issue_single_agent_activity")
def fake_run_issue_single_agent(_request: InternalWorkflowRequest) -> dict:
    return {
        "status": "completed",
        "outcome": {},
        "file_changes": [],
    }


@activity.defn(name="build_issue_single_agent_result_activity")
def fake_build_issue_single_agent_result(
    _request: InternalWorkflowRequest,
    _single_agent_result: dict,
) -> dict:
    return {
        "kind": "issue-single-agent-strategy-result",
        "review_record": {},
    }


@activity.defn(name="analyze_issue_activity")
def fake_analyze_issue(
    _prepared_input: dict,
    _runtime_context: dict,
) -> dict:
    return {
        "status": "completed",
        "narratives": [
            {
                "verdict": "confirmed-vulnerability",
            }
        ],
    }


@activity.defn(name="analyze_issue_activity")
def fake_analyze_issue_runtime_failure(
    _prepared_input: dict,
    _runtime_context: dict,
) -> dict:
    raise ApplicationError("boom from issue analyzer", non_retryable=True)


@activity.defn(name="mitigate_issue_activity")
def fake_mitigate_issue(
    _prepared_input: dict,
    _analysis_result: dict,
    _retry_context: dict | None,
    _runtime_context: dict,
) -> dict:
    return {}


@activity.defn(name="verify_issue_activity")
def fake_verify_issue(
    _prepared_input: dict,
    _analysis_result: dict,
    _mitigation_result: dict | None,
    _retry_context: dict | None,
    _runtime_context: dict,
) -> dict:
    return {
        "resolution_next_step": "none",
    }


@activity.defn(name="archive_issue_feedback_attempt_activity")
def fake_archive_issue_feedback_attempt(
    _prepared_input: dict,
    _retry_context: dict,
) -> None:
    return None


@activity.defn(name="build_issue_review_result_activity")
def fake_build_issue_review_result(
    _analysis_result: dict,
    _mitigation_result: dict | None,
    _verifier_result: dict | None,
) -> dict:
    return {
        "workflow": "issue-review",
    }


@activity.defn(name="build_repository_discovery_manifest_activity")
def fake_build_repository_discovery_manifest(_request: InternalWorkflowRequest) -> dict:
    return {
        "entries": [{"path": "src/app.py"}],
        "skipped_files": [],
        "chunks": [
            {
                "chunk_id": "discovery-chunk-0001",
                "entries": [{"path": "src/app.py"}],
            }
        ],
        "chunk_target_tokens": 100_000,
        "max_concurrency": 1,
        "scan_mode": "full",
    }


@activity.defn(name="scan_repository_discovery_chunk_activity")
def fake_scan_repository_discovery_chunk(
    _manifest: dict,
    chunk: dict,
) -> dict:
    return {
        "chunk_id": chunk["chunk_id"],
        "file_candidates": [],
        "file_results": [],
        "skipped_files": [],
        "tokenUsages": [],
    }


@activity.defn(name="build_repository_discovery_result_activity")
def fake_build_repository_discovery_result(
    _manifest: dict,
    _chunk_results: list[dict],
) -> dict:
    return {
        "counts": {},
    }


@activity.defn(name="triage_repository_activity")
def fake_triage_repository(
    _request: InternalWorkflowRequest,
    _discovery_result: dict,
) -> dict:
    return {
        "counts": {},
        "cases": [
            {
                "case_id": "case-1",
            }
        ],
    }


@activity.defn(name="prepare_repository_case_review_inputs_activity")
def fake_prepare_repository_case_review_inputs(
    request: InternalWorkflowRequest,
    _cases: list[dict],
) -> dict:
    return {
        "max_concurrency": 1,
        "case_requests": [
            {
                "run_id": request.run_id,
                "case_execution_input": _repository_case_execution_input("case-1"),
                "cases_artifacts_path": "/tmp/cases",
                "timeout_seconds": request.timeout_seconds,
                "runtime_context": request.runtime_context,
            }
        ],
    }


@activity.defn(name="prepare_repository_case_activity")
def fake_prepare_repository_case(
    request: dict,
) -> dict:
    return {
        "case_execution_input": request["case_execution_input"],
        "artifact_paths": {
            "analyzer": "/tmp/cases/case-1/analyzer",
            "cvss": "/tmp/cases/case-1/cvss",
            "mitigator": "/tmp/cases/case-1/mitigator",
            "verifier": "/tmp/cases/case-1/verifier",
        },
    }


@activity.defn(name="analyze_repository_case_activity")
def fake_analyze_repository_case(
    _prepared_case: dict,
    _runtime_context: dict,
) -> dict:
    return {
        "verdict": "confirmed-vulnerability",
        "narratives": [
            {
                "verdict": "confirmed-vulnerability",
            }
        ],
    }


@activity.defn(name="score_repository_case_cvss_activity")
def fake_score_repository_case_cvss(
    _prepared_case: dict,
    _analysis_result: dict,
) -> dict:
    return {
        "status": "completed",
    }


@activity.defn(name="build_failed_repository_case_cvss_result_activity")
def fake_build_failed_repository_case_cvss_result(
    _prepared_case: dict,
    error: str,
) -> None:
    _ = error


@activity.defn(name="mitigate_repository_case_activity")
def fake_mitigate_repository_case(
    _prepared_case: dict,
    _analysis_result: dict,
    _retry_context: dict | None,
    _runtime_context: dict,
) -> dict:
    return {
        "status": "completed",
        "changed_files": ["src/app.py"],
    }


@activity.defn(name="verify_repository_case_activity")
def fake_verify_repository_case(
    _prepared_case: dict,
    _analysis_result: dict,
    _mitigation_result: dict | None,
    _retry_context: dict | None,
    _runtime_context: dict,
) -> dict:
    return {
        "status": "completed",
        "patch_coverage": "full",
        "resolution_next_step": "none",
    }


@activity.defn(name="archive_repository_case_feedback_attempt_activity")
def fake_archive_repository_case_feedback_attempt(
    _prepared_case: dict,
    _retry_context: dict,
) -> None:
    return None


@activity.defn(name="build_repository_case_result_activity")
def fake_build_repository_case_result(
    prepared_case: dict,
    _analysis_result: dict,
    _cvss_stage_result: dict,
    _mitigation_result: dict | None,
    _verifier_result: dict | None,
) -> dict:
    return {
        "case_id": prepared_case["case_execution_input"]["case_id"],
        "disposition": "keep",
        "review_record": build_review_record(
            analysis_result=None,
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        ),
    }


@activity.defn(name="plan_repository_delivery_activity")
def fake_plan_repository_delivery(
    _request: InternalWorkflowRequest,
    _case_results: list[dict],
) -> dict:
    return {
        "status": "skipped",
        "deliveries": [],
    }


@activity.defn(name="build_skipped_repository_delivery_result_activity")
def fake_build_skipped_repository_delivery_result(
    _request: InternalWorkflowRequest,
) -> dict:
    return {
        "status": "skipped",
        "deliveries": [],
    }


@activity.defn(name="plan_repository_delivery_activity")
def fake_plan_repository_delivery_with_items(
    _request: InternalWorkflowRequest,
    _case_results: list[dict],
) -> dict:
    return {
        "status": "completed",
        "deliveries": [
            {
                "delivery_id": "delivery-one",
                "strategy": "combined",
                "case_ids": ["case-one"],
                "reason": "test",
            },
            {
                "delivery_id": "delivery-two",
                "strategy": "single",
                "case_ids": ["case-two"],
                "reason": "test",
            },
        ],
    }


@activity.defn(name="prepare_repository_delivery_execution_activity")
def fake_prepare_repository_delivery_execution(
    _request: InternalWorkflowRequest,
    case_results: list[dict],
    delivery_plan: dict,
) -> dict:
    return {
        "max_concurrency": 1,
        "deliveries": delivery_plan["deliveries"],
        "keep_case_ids": [item["case_id"] for item in case_results],
        "single_delivery_execution_items": [
            _fake_delivery_request(index, delivery_entry, case_results)
            for index, delivery_entry in enumerate(delivery_plan["deliveries"])
            if delivery_entry["strategy"] != "combined"
        ],
        "combined_delivery_execution_items": [
            _fake_delivery_request(index, delivery_entry, case_results)
            for index, delivery_entry in enumerate(delivery_plan["deliveries"])
            if delivery_entry["strategy"] == "combined"
        ],
    }


def _fake_delivery_request(
    index: int,
    delivery_entry: dict,
    case_results: list[dict],
) -> dict:
    return {
        "index": index,
        "delivery": delivery_entry,
        "case_items": [
            item
            for item in case_results
            if item["case_id"] in delivery_entry["case_ids"]
        ],
    }


@activity.defn(name="execute_repository_single_deliveries_activity")
def fake_execute_repository_single_deliveries(
    delivery_execution: dict,
) -> list[dict]:
    return [
        {
            "index": delivery_request["index"],
            "outcome": _fake_delivery_outcome(delivery_request),
        }
        for delivery_request in delivery_execution["single_delivery_execution_items"]
    ]


@activity.defn(name="execute_repository_combined_delivery_activity")
def fake_execute_repository_combined_delivery(
    _delivery_execution: dict,
    delivery_request: dict,
) -> dict:
    return _fake_delivery_outcome(delivery_request)


def _fake_delivery_outcome(delivery_request: dict) -> dict:
    delivery = delivery_request["delivery"]
    return {
        "delivery_id": delivery["delivery_id"],
        "status": "ready",
        "error": None,
        "patch_path": None,
        "patch_diff": "",
        "changed_files": [],
        "file_changes": [],
        "applied_case_ids": delivery["case_ids"],
    }


@activity.defn(name="build_repository_delivery_result_activity")
def fake_build_repository_delivery_result(
    _delivery_execution: dict,
    patch_outcomes: list[dict],
) -> dict:
    return {
        "status": "completed",
        "delivery_ids": [item["delivery_id"] for item in patch_outcomes],
    }


@activity.defn(name="build_repository_review_result_activity")
def fake_build_repository_review_result(
    request: InternalWorkflowRequest,
    _scan_result: dict,
    _case_results: list[dict],
    _delivery_result: dict,
) -> dict:
    return {
        "workflow": request.workflow,
    }


@pytest.mark.parametrize(
    ("workflow", "child_workflow_id"),
    [
        ("issue-review", "run-1:issue-review"),
        ("pull-request-review", "run-1:pull-request-review"),
        ("repository-review", "run-1:repository-review"),
    ],
)
@pytest.mark.asyncio
async def test_temporal_backend_starts_and_reads_runner_workflow(
    workflow: str,
    child_workflow_id: str,
) -> None:
    started, fetched, child_result = await _run_temporal_backend_test(
        workflow=workflow,
        child_workflow_id=child_workflow_id,
    )

    assert started == {
        "run_id": "run-1",
        "workflow": workflow,
        "status": "running",
    }
    assert fetched == {
        "run_id": "run-1",
        "workflow": workflow,
        "status": "succeeded",
        "result": {
            "workflow": workflow,
        },
    }
    assert child_result == {
        "ok": True,
        "result": {
            "workflow": workflow,
        },
    }


@pytest.mark.asyncio
async def test_temporal_backend_maps_completed_error_envelope_to_failed_run() -> None:
    fetched = await _run_temporal_error_envelope_test()

    assert fetched == {
        "run_id": "run-error",
        "workflow": "issue-review",
        "status": "failed",
        "error": {
            "category": "input",
            "code": "RUNNER_REQUEST_INVALID",
            "message": "bad input",
            "retryable": False,
            "details": {},
        },
    }


@pytest.mark.asyncio
async def test_record_from_handle_maps_invalid_completed_envelope_to_failed_run() -> (
    None
):
    fetched = await _record_from_handle(_CompletedHandle())

    assert fetched == {
        "run_id": "run-invalid",
        "workflow": "issue-review",
        "status": "failed",
        "error": {
            "category": "runtime",
            "code": "RUNNER_RESPONSE_INVALID",
            "message": (
                "Temporal workflow completed with an invalid runner response envelope."
            ),
            "retryable": False,
            "details": {
                "temporal_status": "COMPLETED",
                "response_type": "dict",
                "ok": True,
            },
        },
    }


@pytest.mark.asyncio
async def test_record_from_handle_treats_missing_temporal_status_as_failed() -> None:
    fetched = await _record_from_handle(_MissingStatusHandle())

    assert fetched["run_id"] == "run-missing-status"
    assert fetched["workflow"] == "issue-review"
    assert fetched["status"] == "failed"
    assert fetched["error"]["details"]["temporal_status"] == "UNKNOWN"


@pytest.mark.asyncio
async def test_record_from_handle_uses_default_workflow_when_memo_is_not_mapping() -> (
    None
):
    fetched = await _record_from_handle(
        _CompletedNonDictMemoHandle(),
        default_workflow="issue-review",
    )

    assert fetched == {
        "run_id": "run-non-dict-memo",
        "workflow": "issue-review",
        "status": "succeeded",
        "result": {"workflow": "issue-review"},
    }


@pytest.mark.asyncio
async def test_temporal_backend_preserves_failed_workflow_cause() -> None:
    fetched = await _run_temporal_failed_workflow_test()

    assert fetched is not None
    assert fetched["run_id"] == "run-boom"
    assert fetched["workflow"] == "issue-review"
    assert fetched["status"] == "failed"
    assert fetched["error"]["category"] == "runtime"
    assert fetched["error"]["code"] == "RUNNER_EXECUTION_FAILED"
    assert "boom from issue analyzer" in fetched["error"]["message"]
    assert fetched["error"]["details"]["temporal_status"] == "FAILED"
    assert fetched["error"]["details"]["name"]
    assert any(
        "boom from issue analyzer" in failure["message"]
        for failure in fetched["error"]["details"]["failure_chain"]
    )


def test_prepare_runner_run_activity_maps_missing_manifest_to_input_error(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    result = prepare_runner_run_activity(
        RunnerExecutionRequest(
            workflow="issue-review",
            run_id="run-missing-manifest",
            input_data={
                "contract_version": "v4",
                "input_bundle_uri": str(tmp_path),
                "review_intent": {"objective": "audit"},
                "issue": {"number": 1},
            },
            timeout_seconds=60,
        )
    )

    assert result["ok"] is False
    assert result["error"]["category"] == "input"
    assert result["error"]["code"] == "RUNNER_REQUEST_INVALID"
    assert "manifest not found" in result["error"]["message"]


@pytest.mark.asyncio
async def test_issue_ablation_temporal_workflows_execute_with_activity_wrappers() -> (
    None
):
    single_result, two_stage_result = await _run_issue_ablation_workflows_test()

    assert single_result == {
        "ok": True,
        "result": {
            "kind": "issue-single-agent-strategy-result",
            "review_record": {},
        },
    }
    assert two_stage_result == {
        "ok": True,
        "result": {
            "kind": "issue-two-stage-strategy-result",
            "review_record": {},
        },
    }


@pytest.mark.asyncio
async def test_repository_delivery_workflow_runs_delivery_item_activities() -> None:
    result = await _run_repository_delivery_workflow_test()

    assert result == {
        "status": "completed",
        "delivery_ids": ["delivery-one", "delivery-two"],
    }


async def _run_temporal_backend_test(
    *,
    workflow: str,
    child_workflow_id: str,
) -> tuple[dict, dict | None, dict]:
    async with temporal_time_skipping_environment() as env:
        backend = TemporalRunnerExecutionBackend(task_queue="runner-service-test")
        backend._client = env.client
        with ThreadPoolExecutor(max_workers=2) as executor:
            async with Worker(
                env.client,
                task_queue="runner-service-test",
                workflows=[
                    RunnerExecutionWorkflow,
                    IssueReviewWorkflow,
                    PullRequestReviewWorkflow,
                    RepositoryDiscoveryWorkflow,
                    RepositoryScanWorkflow,
                    RepositoryCaseProcessingWorkflow,
                    RepositoryCaseReviewWorkflow,
                    RepositoryDeliveryWorkflow,
                    RepositoryReviewWorkflow,
                ],
                activities=[
                    fake_prepare_runner_run,
                    fake_prepare_internal_workflow,
                    fake_analyze_issue,
                    fake_mitigate_issue,
                    fake_verify_issue,
                    fake_archive_issue_feedback_attempt,
                    fake_build_issue_review_result,
                    fake_analyze_pull_request,
                    fake_mitigate_pull_request,
                    fake_verify_pull_request,
                    fake_archive_pull_request_feedback_attempt,
                    fake_build_pull_request_review_result,
                    fake_build_repository_discovery_manifest,
                    fake_scan_repository_discovery_chunk,
                    fake_build_repository_discovery_result,
                    fake_triage_repository,
                    fake_prepare_repository_case_review_inputs,
                    fake_prepare_repository_case,
                    fake_analyze_repository_case,
                    fake_score_repository_case_cvss,
                    fake_build_failed_repository_case_cvss_result,
                    fake_mitigate_repository_case,
                    fake_verify_repository_case,
                    fake_archive_repository_case_feedback_attempt,
                    fake_build_repository_case_result,
                    fake_plan_repository_delivery,
                    fake_build_skipped_repository_delivery_result,
                    fake_build_repository_review_result,
                ],
                activity_executor=executor,
            ):
                started = await backend.start(
                    workflow=workflow,
                    run_id="run-1",
                    input_data={},
                )
                await env.client.get_workflow_handle("run-1").result()
                fetched = await backend.get("run-1")
                child_result = await env.client.get_workflow_handle(
                    child_workflow_id
                ).result()
                return started, fetched, child_result
    raise AssertionError("Temporal test worker exited before returning a result.")


async def _run_repository_delivery_workflow_test() -> dict[str, Any]:
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=2) as executor:
            async with Worker(
                env.client,
                task_queue="repository-delivery-test",
                workflows=[RepositoryDeliveryWorkflow],
                activities=[
                    fake_plan_repository_delivery_with_items,
                    fake_prepare_repository_delivery_execution,
                    fake_execute_repository_single_deliveries,
                    fake_execute_repository_combined_delivery,
                    fake_build_repository_delivery_result,
                ],
                activity_executor=executor,
            ):
                request = InternalWorkflowRequest(
                    workflow="repository-review",
                    run_id="run-delivery",
                    prepared_input={},
                    timeout_seconds=30,
                    runtime_context={},
                )
                return await env.client.execute_workflow(
                    RepositoryDeliveryWorkflow.run,
                    args=[
                        request,
                        [
                            {"case_id": "case-one", "disposition": "keep"},
                            {"case_id": "case-two", "disposition": "keep"},
                        ],
                    ],
                    id="repository-delivery",
                    task_queue="repository-delivery-test",
                )
    raise AssertionError("Temporal test worker exited before returning a result.")


async def _run_issue_ablation_workflows_test() -> tuple[dict, dict]:
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=2) as executor:
            async with Worker(
                env.client,
                task_queue="issue-ablation-test",
                workflows=[
                    IssueSingleAgentWorkflow,
                    IssueTwoStageWorkflow,
                ],
                activities=[
                    fake_prepare_internal_workflow,
                    fake_analyze_issue,
                    fake_mitigate_issue_self_check,
                    fake_run_issue_single_agent,
                    fake_build_issue_single_agent_result,
                    fake_build_issue_two_stage_result_activity,
                ],
                activity_executor=executor,
            ):
                request = InternalWorkflowRequest(
                    workflow="issue-review",
                    run_id="run-ablation",
                    prepared_input={},
                    timeout_seconds=30,
                    runtime_context={},
                )
                single_result = await env.client.execute_workflow(
                    IssueSingleAgentWorkflow.run,
                    request,
                    id="issue-single-agent",
                    task_queue="issue-ablation-test",
                )
                two_stage_result = await env.client.execute_workflow(
                    IssueTwoStageWorkflow.run,
                    request,
                    id="issue-two-stage",
                    task_queue="issue-ablation-test",
                )
                return single_result, two_stage_result
    raise AssertionError("Temporal test worker exited before returning a result.")


async def _run_temporal_error_envelope_test() -> dict | None:
    async with temporal_time_skipping_environment() as env:
        backend = TemporalRunnerExecutionBackend(task_queue="runner-service-test")
        backend._client = env.client
        with ThreadPoolExecutor(max_workers=1) as executor:
            async with Worker(
                env.client,
                task_queue="runner-service-test",
                workflows=[RunnerExecutionWorkflow],
                activities=[fake_prepare_runner_run_failure],
                activity_executor=executor,
            ):
                await backend.start(
                    workflow="issue-review",
                    run_id="run-error",
                    input_data={},
                )
                await env.client.get_workflow_handle("run-error").result()
                return await backend.get("run-error")
    raise AssertionError("Temporal test worker exited before returning a result.")


async def _run_temporal_failed_workflow_test() -> dict | None:
    async with temporal_time_skipping_environment() as env:
        backend = TemporalRunnerExecutionBackend(
            task_queue="runner-service-failure-test"
        )
        backend._client = env.client
        with ThreadPoolExecutor(max_workers=2) as executor:
            async with Worker(
                env.client,
                task_queue="runner-service-failure-test",
                workflows=[
                    RunnerExecutionWorkflow,
                    IssueReviewWorkflow,
                ],
                activities=[
                    fake_prepare_runner_run,
                    fake_prepare_internal_workflow,
                    fake_analyze_issue_runtime_failure,
                ],
                activity_executor=executor,
            ):
                await backend.start(
                    workflow="issue-review",
                    run_id="run-boom",
                    input_data={},
                )
                with pytest.raises(Exception):
                    await env.client.get_workflow_handle("run-boom").result()
                return await backend.get("run-boom")
    raise AssertionError("Temporal test worker exited before returning a result.")
