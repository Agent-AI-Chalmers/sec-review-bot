import asyncio
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch

import pytest
from temporalio import activity
from temporalio.worker import Worker

from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.repository import direct as repository_direct
from sec_review_agents.workflows.repository.case_execution_input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseProcessingWorkflow,
    RepositoryCaseReviewRequest,
    RepositoryCaseReviewWorkflow,
    RepositoryDiscoveryWorkflow,
    resolve_repository_case_processing_max_concurrency,
)
from sec_review_agents.workflows.repository_case import direct as repository_case_direct
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED
from tests.temporal_test_utils import temporal_time_skipping_environment


def assert_not_run_review_record(review_record: dict) -> None:
    assert review_record["analysis"]["verdict"] is None
    assert review_record["mitigation"]["changed_files"] == []
    assert review_record["verification"]["patch_coverage"] is None
    assert review_record["cvss"] is None


def repository_case_execution_input(case_id: str) -> RepositoryCaseExecutionInput:
    return {
        "case_id": case_id,
        "review_input": f"Prepared {case_id} review input.",
        "workspace_snapshot_tar_path": "/tmp/workspace.snapshot.tar",
        "history_path": "/tmp/history",
        "scan_mode": "full",
        "incremental_window_path": None,
        "repair_mode": REPAIR_MODE_TEST_CHANGES_ALLOWED,
    }


def _internal_workflow_request(run_id: str = "run-test") -> InternalWorkflowRequest:
    return InternalWorkflowRequest(
        workflow="repository-review",
        run_id=run_id,
        prepared_input={"run_id": run_id},
        timeout_seconds=30,
        runtime_context={},
    )


def repository_case_review_request(case_id: str) -> RepositoryCaseReviewRequest:
    return {
        "run_id": "run-test",
        "case_execution_input": repository_case_execution_input(case_id),
        "cases_artifacts_path": "/tmp/cases",
        "transcript_thread_path": f"/tmp/transcripts/{case_id}",
        "timeout_seconds": 30,
        "runtime_context": {},
    }


@pytest.mark.asyncio
async def test_direct_repository_scan_awaits_async_triage_activity() -> None:
    request = _internal_workflow_request()
    discovery_result = {"candidates": [{"candidate_id": "candidate-a"}]}
    triage_result = {"cases": [{"case_id": "case-a"}]}

    async def fake_triage(_request, _discovery_result):
        assert _request is request
        assert _discovery_result is discovery_result
        return triage_result

    with (
        patch.object(
            repository_direct,
            "run_repository_discovery_direct",
            return_value=discovery_result,
        ),
        patch.object(
            repository_direct,
            "triage_repository_activity",
            side_effect=fake_triage,
        ),
    ):
        result = await repository_direct.run_repository_scan_direct(request)

    assert result == {
        "discovery_result": discovery_result,
        "triage_result": triage_result,
    }


@pytest.mark.asyncio
async def test_direct_repository_discovery_refills_sliding_window() -> None:
    chunks = [{"chunk_id": f"chunk-{index}"} for index in range(4)]
    active_count = 0
    max_active_count = 0

    def fake_build_manifest(_request):
        return {"max_concurrency": 2, "chunks": chunks}

    async def fake_scan_chunk(_manifest, chunk):
        nonlocal active_count, max_active_count
        active_count += 1
        max_active_count = max(max_active_count, active_count)
        await asyncio.sleep(0)
        active_count -= 1
        return {"chunk_id": chunk["chunk_id"]}

    def fake_build_result(_manifest, chunk_results):
        return {"chunk_ids": [item["chunk_id"] for item in chunk_results]}

    with (
        patch.object(
            repository_direct,
            "build_repository_discovery_manifest_activity",
            side_effect=fake_build_manifest,
        ),
        patch.object(
            repository_direct,
            "scan_repository_discovery_chunk_activity",
            side_effect=fake_scan_chunk,
        ),
        patch.object(
            repository_direct,
            "build_repository_discovery_result_activity",
            side_effect=fake_build_result,
        ),
    ):
        result = await repository_direct.run_repository_discovery_direct(
            _internal_workflow_request()
        )

    assert result == {"chunk_ids": ["chunk-0", "chunk-1", "chunk-2", "chunk-3"]}
    assert max_active_count == 2


def test_resolve_case_processing_max_concurrency_honors_bounds() -> None:
    with patch.dict(os.environ, {}, clear=True):
        assert resolve_repository_case_processing_max_concurrency(0) == 1
        assert resolve_repository_case_processing_max_concurrency(1) == 1
        assert resolve_repository_case_processing_max_concurrency(3) == 1

    with patch.dict(
        os.environ, {"AGENT_CASE_PROCESSING_MAX_CONCURRENCY": "12"}, clear=False
    ):
        assert resolve_repository_case_processing_max_concurrency(5) == 5

    with patch.dict(
        os.environ, {"AGENT_CASE_PROCESSING_MAX_CONCURRENCY": "2"}, clear=False
    ):
        assert resolve_repository_case_processing_max_concurrency(5) == 2


@pytest.mark.asyncio
async def test_repository_review_workflow_isolates_case_failure_and_refills_window() -> (
    None
):
    case_3_started = threading.Event()

    @activity.defn(name="prepare_repository_case_review_inputs_activity")
    def fake_prepare_case_review_inputs(
        _request: InternalWorkflowRequest,
        _cases: list[dict],
    ) -> dict:
        return {
            "max_concurrency": 2,
            "case_requests": [
                repository_case_review_request("case-1"),
                repository_case_review_request("case-2"),
                repository_case_review_request("case-3"),
            ],
        }

    @activity.defn(name="prepare_repository_case_activity")
    def fake_prepare_repository_case(request: dict) -> dict:
        case_id = request["case_execution_input"]["case_id"]
        return {
            "case_execution_input": request["case_execution_input"],
            "artifact_paths": {
                "analyzer": f"/tmp/cases/{case_id}/analyzer",
                "cvss": f"/tmp/cases/{case_id}/cvss",
                "mitigator": f"/tmp/cases/{case_id}/mitigator",
                "verifier": f"/tmp/cases/{case_id}/verifier",
            },
        }

    @activity.defn(name="analyze_repository_case_activity")
    def fake_analyzer(prepared_case: dict, _runtime_context: dict) -> dict:
        case_id = prepared_case["case_execution_input"]["case_id"]
        if case_id == "case-2":
            raise RuntimeError("case-2 analyzer failed")
        if case_id == "case-3":
            case_3_started.set()
        return {
            "verdict": "confirmed-vulnerability",
            "narratives": [
                {
                    "priority": 1,
                    "verdict": "confirmed-defect",
                    "title": f"{case_id} narrative",
                }
            ],
        }

    @activity.defn(name="score_repository_case_cvss_activity")
    def fake_cvss(_prepared_case: dict, _analysis_result: dict) -> dict:
        return {
            "outcome": "scored",
            "base_score": 7.5,
            "severity": "high",
        }

    @activity.defn(name="build_failed_repository_case_cvss_result_activity")
    def fake_failed_cvss(_prepared_case: dict, error: str) -> None:
        _ = error

    @activity.defn(name="mitigate_repository_case_activity")
    def fake_mitigator(
        prepared_case: dict,
        _analysis_result: dict,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        case_id = prepared_case["case_execution_input"]["case_id"]
        if case_id == "case-1" and not case_3_started.wait(2.0):
            raise RuntimeError("case window was not refilled while case-1 ran")
        return {
            "status": "completed",
            "changed_files": [f"{case_id}.py"],
        }

    @activity.defn(name="verify_repository_case_activity")
    def fake_verifier(
        _prepared_case: dict,
        _analysis_result: dict,
        _mitigation_result: dict | None,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {
            "overview": "Verified.",
            "review_target_claim": "target claim",
            "patch_coverage": "full",
            "resolution_next_step": "none",
            "patch_findings": [],
            "verification_findings": [],
            "residual_risks": [],
        }

    @activity.defn(name="archive_repository_case_feedback_attempt_activity")
    def fake_archive(_prepared_case: dict, _retry_context: dict) -> None:
        return None

    @activity.defn(name="build_repository_case_result_activity")
    def fake_build_result(
        prepared_case: dict,
        _analysis_result: dict,
        cvss_result: dict | None,
        mitigation_result: dict | None,
        verifier_result: dict | None,
    ) -> dict:
        case_id = prepared_case["case_execution_input"]["case_id"]
        return {
            "case_id": case_id,
            "disposition": "keep",
            "reason": "unit-test",
            "review_record": {
                "cvss": cvss_result,
                "mitigation": mitigation_result or {},
                "verification": verifier_result or {},
            },
        }

    async def run_workflow() -> list[dict]:
        async with temporal_time_skipping_environment() as env:
            with ThreadPoolExecutor(max_workers=4) as executor:
                async with Worker(
                    env.client,
                    task_queue="repository-review-concurrency-test",
                    workflows=[
                        RepositoryCaseProcessingWorkflow,
                        RepositoryCaseReviewWorkflow,
                    ],
                    activities=[
                        fake_prepare_case_review_inputs,
                        fake_prepare_repository_case,
                        fake_analyzer,
                        fake_cvss,
                        fake_failed_cvss,
                        fake_mitigator,
                        fake_verifier,
                        fake_archive,
                        fake_build_result,
                    ],
                    activity_executor=executor,
                ):
                    return await env.client.execute_workflow(
                        RepositoryCaseProcessingWorkflow.run,
                        args=[
                            InternalWorkflowRequest(
                                workflow="repository-review",
                                run_id="run-test",
                                prepared_input={},
                                timeout_seconds=30,
                                runtime_context={},
                            ),
                            {"triage_result": {"cases": [{}, {}, {}]}},
                        ],
                        id="repository-review-concurrency-test",
                        task_queue="repository-review-concurrency-test",
                    )
        raise AssertionError("Temporal test worker exited before returning.")

    results = await run_workflow()

    assert [item["case_id"] for item in results] == ["case-1", "case-2", "case-3"]
    assert results[0]["disposition"] == "keep"
    assert results[1]["disposition"] == "blocked"
    assert "Case processing failed after retries" in results[1]["reason"]
    assert_not_run_review_record(results[1]["review_record"])
    assert results[2]["disposition"] == "keep"


@pytest.mark.asyncio
async def test_direct_repository_review_isolates_case_failure() -> None:
    case_requests = [
        {
            "case_execution_input": repository_case_execution_input("case-1"),
        },
        {
            "case_execution_input": repository_case_execution_input("case-2"),
        },
        {
            "case_execution_input": repository_case_execution_input("case-3"),
        },
    ]

    def fake_run_case(case_request: dict) -> dict:
        case_id = case_request["case_execution_input"]["case_id"]
        if case_id == "case-2":
            raise RuntimeError("case-2 failed")
        return {
            "case_id": case_id,
            "disposition": "keep",
        }

    with (
        patch.object(
            repository_direct,
            "prepare_repository_case_review_inputs_activity",
            return_value={"max_concurrency": 2, "case_requests": case_requests},
        ),
        patch.object(
            repository_case_direct,
            "run_repository_case_review_direct",
            side_effect=fake_run_case,
        ),
    ):
        results = await repository_direct.run_repository_case_reviews_direct(
            InternalWorkflowRequest(
                workflow="repository-review",
                run_id="run-test",
                prepared_input={},
                timeout_seconds=30,
                runtime_context={},
            ),
            {"triage_result": {"cases": [{}, {}, {}]}},
        )

    assert [item["case_id"] for item in results] == ["case-1", "case-2", "case-3"]
    assert results[1]["disposition"] == "blocked"
    assert "Case processing failed" in results[1]["reason"]
    assert_not_run_review_record(results[1]["review_record"])


@pytest.mark.asyncio
async def test_direct_repository_case_review_fanout_is_bounded() -> None:
    case_requests = [
        {
            "case_execution_input": repository_case_execution_input(f"case-{index}"),
        }
        for index in range(1, 6)
    ]
    active_count = 0
    max_active_count = 0

    async def fake_run_case(case_request: dict) -> dict:
        nonlocal active_count, max_active_count
        case_id = case_request["case_execution_input"]["case_id"]
        active_count += 1
        max_active_count = max(max_active_count, active_count)
        await asyncio.sleep(0)
        active_count -= 1
        return {
            "case_id": case_id,
            "disposition": "keep",
        }

    with (
        patch.object(
            repository_direct,
            "prepare_repository_case_review_inputs_activity",
            return_value={"max_concurrency": 2, "case_requests": case_requests},
        ),
        patch.object(
            repository_case_direct,
            "run_repository_case_review_direct",
            side_effect=fake_run_case,
        ),
    ):
        results = await repository_direct.run_repository_case_reviews_direct(
            InternalWorkflowRequest(
                workflow="repository-review",
                run_id="run-test",
                prepared_input={},
                timeout_seconds=30,
                runtime_context={},
            ),
            {"triage_result": {"cases": [{}, {}, {}, {}, {}]}},
        )

    assert [item["case_id"] for item in results] == [
        "case-1",
        "case-2",
        "case-3",
        "case-4",
        "case-5",
    ]
    assert max_active_count == 2


@pytest.mark.asyncio
async def test_repository_discovery_workflow_refills_chunk_window() -> None:
    chunk_3_started = threading.Event()

    @activity.defn(name="build_repository_discovery_manifest_activity")
    def fake_build_discovery_manifest(
        _request: InternalWorkflowRequest,
    ) -> dict:
        return {
            "entries": [],
            "skipped_files": [],
            "chunks": [
                {"chunk_id": "discovery-chunk-0001"},
                {"chunk_id": "discovery-chunk-0002"},
                {"chunk_id": "discovery-chunk-0003"},
            ],
            "chunk_target_tokens": 100_000,
            "max_concurrency": 2,
            "scan_mode": "full",
        }

    @activity.defn(name="scan_repository_discovery_chunk_activity")
    def fake_scan_discovery_chunk(_manifest: dict, chunk: dict) -> dict:
        chunk_id = chunk["chunk_id"]
        if chunk_id == "discovery-chunk-0001" and not chunk_3_started.wait(2.0):
            raise RuntimeError("discovery chunk window was not refilled")
        if chunk_id == "discovery-chunk-0003":
            chunk_3_started.set()
        return {
            "chunk_id": chunk_id,
            "file_candidates": [],
            "file_results": [],
            "skipped_files": [],
            "tokenUsages": [],
        }

    @activity.defn(name="build_repository_discovery_result_activity")
    def fake_build_discovery_result(
        _manifest: dict,
        chunk_results: list[dict],
    ) -> dict:
        return {
            "chunk_ids": [item["chunk_id"] for item in chunk_results],
        }

    async def run_workflow() -> dict:
        async with temporal_time_skipping_environment() as env:
            with ThreadPoolExecutor(max_workers=3) as executor:
                async with Worker(
                    env.client,
                    task_queue="repository-discovery-concurrency-test",
                    workflows=[RepositoryDiscoveryWorkflow],
                    activities=[
                        fake_build_discovery_manifest,
                        fake_scan_discovery_chunk,
                        fake_build_discovery_result,
                    ],
                    activity_executor=executor,
                ):
                    return await env.client.execute_workflow(
                        RepositoryDiscoveryWorkflow.run,
                        InternalWorkflowRequest(
                            workflow="repository-review",
                            run_id="run-test",
                            prepared_input={},
                            timeout_seconds=30,
                            runtime_context={},
                        ),
                        id="repository-discovery-concurrency-test",
                        task_queue="repository-discovery-concurrency-test",
                    )
        raise AssertionError("Temporal test worker exited before returning.")

    result = await run_workflow()

    assert result["chunk_ids"] == [
        "discovery-chunk-0001",
        "discovery-chunk-0002",
        "discovery-chunk-0003",
    ]


@pytest.mark.asyncio
async def test_run_case_processing_starts_cvss_and_mitigation_in_parallel() -> None:
    cvss_started = threading.Event()
    mitigator_started = threading.Event()

    @activity.defn(name="prepare_repository_case_activity")
    def fake_prepare_repository_case(request: dict) -> dict:
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
    def fake_analyzer(_prepared_case: dict, _runtime_context: dict) -> dict:
        return {
            "verdict": "confirmed-vulnerability",
            "narratives": [
                {
                    "priority": 1,
                    "verdict": "confirmed-defect",
                    "title": "demo narrative",
                }
            ],
        }

    @activity.defn(name="score_repository_case_cvss_activity")
    def fake_cvss(_prepared_case: dict, _analysis_result: dict) -> dict:
        cvss_started.set()
        if not mitigator_started.wait(1.0):
            raise RuntimeError("Mitigator did not start while CVSS stage was running.")
        return {
            "outcome": "scored",
            "base_score": 8.8,
            "severity": "high",
        }

    @activity.defn(name="build_failed_repository_case_cvss_result_activity")
    def fake_failed_cvss(_prepared_case: dict, error: str) -> None:
        _ = error

    @activity.defn(name="mitigate_repository_case_activity")
    def fake_mitigator(
        _prepared_case: dict,
        _analysis_result: dict,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        mitigator_started.set()
        if not cvss_started.wait(1.0):
            raise RuntimeError("CVSS did not start while mitigation stage was running.")
        return {
            "changed_files": ["demo.py"],
        }

    @activity.defn(name="verify_repository_case_activity")
    def fake_verifier(
        _prepared_case: dict,
        _analysis_result: dict,
        _mitigation_result: dict | None,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {
            "overview": "No patch was available to verify.",
            "review_target_claim": "target claim",
            "patch_coverage": "no-patch",
            "resolution_next_step": "manual-review",
            "patch_findings": [],
            "verification_findings": [],
            "residual_risks": [],
        }

    @activity.defn(name="archive_repository_case_feedback_attempt_activity")
    def fake_archive(_prepared_case: dict, _retry_context: dict) -> None:
        return None

    @activity.defn(name="build_repository_case_result_activity")
    def fake_build_result(
        prepared_case: dict,
        _analysis_result: dict,
        cvss_result: dict,
        _mitigation_result: dict | None,
        verifier_result: dict | None,
    ) -> dict:
        return {
            "case_id": prepared_case["case_execution_input"]["case_id"],
            "disposition": "blocked",
            "review_record": {
                "cvss": cvss_result,
                "verification": verifier_result or {},
            },
        }

    async def run_workflow() -> dict:
        async with temporal_time_skipping_environment() as env:
            with ThreadPoolExecutor(max_workers=2) as executor:
                async with Worker(
                    env.client,
                    task_queue="repository-case-concurrency-test",
                    workflows=[RepositoryCaseReviewWorkflow],
                    activities=[
                        fake_prepare_repository_case,
                        fake_analyzer,
                        fake_cvss,
                        fake_failed_cvss,
                        fake_mitigator,
                        fake_verifier,
                        fake_archive,
                        fake_build_result,
                    ],
                    activity_executor=executor,
                ):
                    request = repository_case_review_request("case-1")
                    return await env.client.execute_workflow(
                        RepositoryCaseReviewWorkflow.run,
                        request,
                        id="repository-case-concurrency-test",
                        task_queue="repository-case-concurrency-test",
                    )
        raise AssertionError("Temporal test worker exited before returning.")

    result = await run_workflow()

    assert result["case_id"] == "case-1"
    assert result["review_record"]["cvss"]["outcome"] == "scored"
    assert result["review_record"]["verification"]["patch_coverage"] == "no-patch"
    assert "diagnostics" not in result


@pytest.mark.asyncio
async def test_run_case_processing_cvss_failure_does_not_block_case() -> None:
    @activity.defn(name="prepare_repository_case_activity")
    def fake_prepare_repository_case(request: dict) -> dict:
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
    def fake_analyzer(_prepared_case: dict, _runtime_context: dict) -> dict:
        return {"verdict": "confirmed-vulnerability"}

    @activity.defn(name="score_repository_case_cvss_activity")
    def fake_cvss(_prepared_case: dict, _analysis_result: dict) -> dict:
        raise RuntimeError("cvss failed after retries")

    @activity.defn(name="build_failed_repository_case_cvss_result_activity")
    def fake_failed_cvss(_prepared_case: dict, error: str) -> None:
        _ = error

    @activity.defn(name="mitigate_repository_case_activity")
    def fake_mitigator(
        _prepared_case: dict,
        _analysis_result: dict,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {"changed_files": ["demo.py"]}

    @activity.defn(name="verify_repository_case_activity")
    def fake_verifier(
        _prepared_case: dict,
        _analysis_result: dict,
        _mitigation_result: dict | None,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {
            "overview": "Verified.",
            "review_target_claim": "target claim",
            "patch_coverage": "full",
            "resolution_next_step": "none",
            "patch_findings": [],
            "verification_findings": [],
            "residual_risks": [],
        }

    @activity.defn(name="archive_repository_case_feedback_attempt_activity")
    def fake_archive(_prepared_case: dict, _retry_context: dict) -> None:
        return None

    @activity.defn(name="build_repository_case_result_activity")
    def fake_build_result(
        prepared_case: dict,
        _analysis_result: dict,
        cvss_result: dict | None,
        _mitigation_result: dict | None,
        verifier_result: dict | None,
    ) -> dict:
        return {
            "case_id": prepared_case["case_execution_input"]["case_id"],
            "disposition": "keep",
            "review_record": {
                "cvss": cvss_result,
                "verification": verifier_result or {},
            },
        }

    async def run_workflow() -> dict:
        async with temporal_time_skipping_environment() as env:
            with ThreadPoolExecutor(max_workers=2) as executor:
                async with Worker(
                    env.client,
                    task_queue="repository-case-cvss-failure-test",
                    workflows=[RepositoryCaseReviewWorkflow],
                    activities=[
                        fake_prepare_repository_case,
                        fake_analyzer,
                        fake_cvss,
                        fake_failed_cvss,
                        fake_mitigator,
                        fake_verifier,
                        fake_archive,
                        fake_build_result,
                    ],
                    activity_executor=executor,
                ):
                    request = repository_case_review_request("case-1")
                    return await env.client.execute_workflow(
                        RepositoryCaseReviewWorkflow.run,
                        request,
                        id="repository-case-cvss-failure-test",
                        task_queue="repository-case-cvss-failure-test",
                    )
        raise AssertionError("Temporal test worker exited before returning.")

    result = await run_workflow()

    assert result["disposition"] == "keep"
    assert result["review_record"]["cvss"] is None
    assert result["review_record"]["verification"]["patch_coverage"] == "full"


@pytest.mark.asyncio
async def test_direct_case_processing_starts_cvss_and_mitigation_in_parallel() -> None:
    cvss_started = threading.Event()
    mitigator_started = threading.Event()

    prepared_case: dict[str, Any] = {
        "case_execution_input": repository_case_execution_input("case-1"),
        "artifact_paths": {
            "analyzer": "/tmp/cases/case-1/analyzer",
            "cvss": "/tmp/cases/case-1/cvss",
            "mitigator": "/tmp/cases/case-1/mitigator",
            "verifier": "/tmp/cases/case-1/verifier",
        },
    }

    async def fake_cvss(_prepared_case: dict, _analysis_result: dict) -> dict:
        cvss_started.set()
        if not await asyncio.to_thread(mitigator_started.wait, 1.0):
            raise RuntimeError(
                "Mitigator did not start while direct CVSS stage was running."
            )
        return {
            "outcome": "scored",
            "base_score": 8.8,
            "severity": "high",
        }

    async def fake_mitigator(
        _prepared_case: dict,
        _analysis_result: dict,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        mitigator_started.set()
        if not await asyncio.to_thread(cvss_started.wait, 1.0):
            raise RuntimeError(
                "CVSS did not start while direct mitigation stage was running."
            )
        return {
            "changed_files": ["demo.py"],
        }

    async def fake_analyzer(
        _prepared_case: dict,
        _runtime_context: dict,
    ) -> dict:
        return {"verdict": "confirmed-vulnerability"}

    async def fake_verifier(
        _prepared_case: dict,
        _analysis_result: dict,
        _mitigation_result: dict | None,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {"patch_coverage": "no-patch"}

    def fake_build_result(
        prepared_case: dict,
        _analysis_result: dict,
        cvss_result: dict,
        _mitigation_result: dict | None,
        _verifier_result: dict | None,
    ) -> dict:
        return {
            "case_id": prepared_case["case_execution_input"]["case_id"],
            "review_record": {
                "cvss": cvss_result,
            },
        }

    with (
        patch.object(
            repository_case_direct,
            "prepare_repository_case_activity",
            return_value=prepared_case,
        ),
        patch.object(
            repository_case_direct,
            "analyze_repository_case_activity",
            side_effect=fake_analyzer,
        ),
        patch.object(
            repository_case_direct,
            "score_repository_case_cvss_activity",
            side_effect=fake_cvss,
        ),
        patch.object(
            repository_case_direct,
            "mitigate_repository_case_activity",
            side_effect=fake_mitigator,
        ),
        patch.object(
            repository_case_direct,
            "verify_repository_case_activity",
            side_effect=fake_verifier,
        ),
        patch.object(
            repository_case_direct,
            "should_retry_from_verifier_result",
            return_value=False,
        ),
        patch.object(
            repository_case_direct,
            "build_repository_case_result_activity",
            side_effect=fake_build_result,
        ),
    ):
        result = await repository_case_direct.run_repository_case_review_direct(
            {
                "run_id": "run-test",
                "case_execution_input": prepared_case["case_execution_input"],
                "cases_artifacts_path": "/tmp/local/artifacts/run-test/cases",
                "transcript_thread_path": "/tmp/local/artifacts/run-test/transcripts/case-1",
                "timeout_seconds": 30,
                "runtime_context": {},
            }
        )

    assert result["case_id"] == "case-1"
    assert result["review_record"]["cvss"]["outcome"] == "scored"


@pytest.mark.asyncio
async def test_direct_case_processing_cvss_failure_does_not_block_case() -> None:
    prepared_case: dict[str, Any] = {
        "case_execution_input": repository_case_execution_input("case-1"),
        "artifact_paths": {
            "analyzer": "/tmp/cases/case-1/analyzer",
            "cvss": "/tmp/cases/case-1/cvss",
            "mitigator": "/tmp/cases/case-1/mitigator",
            "verifier": "/tmp/cases/case-1/verifier",
        },
    }

    async def fake_analyzer(
        _prepared_case: dict,
        _runtime_context: dict,
    ) -> dict:
        return {"verdict": "confirmed-vulnerability"}

    async def fake_cvss(_prepared_case: dict, _analysis_result: dict) -> dict:
        raise RuntimeError("cvss model failed")

    async def fake_mitigator(
        _prepared_case: dict,
        _analysis_result: dict,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {"changed_files": ["demo.py"]}

    async def fake_verifier(
        _prepared_case: dict,
        _analysis_result: dict,
        _mitigation_result: dict | None,
        _retry_context: dict | None,
        _runtime_context: dict,
    ) -> dict:
        return {"patch_coverage": "full"}

    def fake_failed_cvss(_prepared_case: dict, error: str) -> None:
        _ = error

    def fake_build_result(
        prepared_case: dict,
        _analysis_result: dict,
        cvss_result: dict | None,
        _mitigation_result: dict | None,
        _verifier_result: dict | None,
    ) -> dict:
        return {
            "case_id": prepared_case["case_execution_input"]["case_id"],
            "review_record": {
                "cvss": cvss_result,
            },
        }

    with (
        patch.object(
            repository_case_direct,
            "prepare_repository_case_activity",
            return_value=prepared_case,
        ),
        patch.object(
            repository_case_direct,
            "analyze_repository_case_activity",
            side_effect=fake_analyzer,
        ),
        patch.object(
            repository_case_direct,
            "score_repository_case_cvss_activity",
            side_effect=fake_cvss,
        ),
        patch.object(
            repository_case_direct,
            "mitigate_repository_case_activity",
            side_effect=fake_mitigator,
        ),
        patch.object(
            repository_case_direct,
            "verify_repository_case_activity",
            side_effect=fake_verifier,
        ),
        patch.object(
            repository_case_direct,
            "build_failed_repository_case_cvss_result_activity",
            side_effect=fake_failed_cvss,
        ),
        patch.object(
            repository_case_direct,
            "should_retry_from_verifier_result",
            return_value=False,
        ),
        patch.object(
            repository_case_direct,
            "build_repository_case_result_activity",
            side_effect=fake_build_result,
        ),
    ):
        result = await repository_case_direct.run_repository_case_review_direct(
            {
                "run_id": "run-test",
                "case_execution_input": prepared_case["case_execution_input"],
                "cases_artifacts_path": "/tmp/local/artifacts/run-test/cases",
                "transcript_thread_path": "/tmp/local/artifacts/run-test/transcripts/case-1",
                "timeout_seconds": 30,
                "runtime_context": {},
            }
        )

    assert result["case_id"] == "case-1"
    assert result["review_record"]["cvss"] is None
