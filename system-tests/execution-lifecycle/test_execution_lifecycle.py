"""Manual-only execution lifecycle with real infrastructure and deterministic analysis.

The production execution/issue workflows, input preparation, result projection,
diagnostic publication, Gateway and Review Runs persistence all run. Only the
analysis activity and later model invocations are replaced, so this tests
orchestration rather than LLM quality.
"""

import asyncio
import json
import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from project_paths import CONTRACTS_ROOT, REPOSITORY_ROOT, SYSTEM_TESTS_ROOT
from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.agents.verification.model import VerificationOutput
from sec_review_agents.artifacts.materialize import materialize_verified_artifact_file
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.entrypoints.execution_worker.workflow import (
    ExecutionWorkflow,
    prepare_execution_run_activity,
)
from sec_review_agents.execution_archives.publication import (
    publish_execution_archive_activity,
)
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.temporal.client import connect_temporal_client
from sec_review_agents.workflows.issue.workflow import (
    IssueReviewWorkflow,
    build_issue_review_result_activity,
    mitigate_issue_activity,
    verify_issue_activity,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from temporalio import activity
from temporalio.worker import Worker


@activity.defn(name="analyze_issue_activity")
async def deterministic_analysis(request: ReviewWorkflowRequest) -> AnalysisStageResult:
    """Retry once to exercise activity recovery without contacting a model."""
    if activity.info().attempt == 1:
        raise RuntimeError("Injected transient analysis failure")
    trajectory = Path(request.prepared_input.artifact_root_path) / "trajectories"
    trajectory.mkdir(parents=True, exist_ok=True)
    (trajectory / "0001.jsonl").write_text('{"event":"deterministic-analysis"}\n')
    return AnalysisStageResult(
        overview="Deterministic lifecycle probe", verdict="no-actionable-finding"
    )


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_execution_completes_and_persists(
    postgres, temporal, object_store, monkeypatch, tmp_path
):
    async def no_changes(**_kwargs):
        return MitigationOutput(overview="No changes needed.")

    async def verify_no_changes(**_kwargs):
        return VerificationOutput(
            overview="No changes needed.",
            target_claim="Deterministic lifecycle probe",
            coverage="full",
            next_step="none",
            validation_level="static",
            regression="not-run",
            findings=[],
            evidence=["No actionable finding or patch."],
            residual_risks=[],
        )

    # Keep real stage setup, snapshot restoration, and result persistence while
    # replacing model invocations, which always run even without repair targets.
    monkeypatch.setattr(
        "sec_review_agents.review_stages.mitigation.stage.run_mitigation_agent",
        no_changes,
    )
    monkeypatch.setattr(
        "sec_review_agents.review_stages.verification.stage.run_verification_agent",
        verify_no_changes,
    )
    for key, value in {
        **object_store,
        "AGENT_MEMORY_PROCESSING_ENABLED": "false",
        "SEC_REVIEW_AGENT_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        "SEC_REVIEW_AGENT_RUN_INPUT_ROOT": str(tmp_path / "inputs"),
    }.items():
        monkeypatch.setenv(key, value)
    run_id = f"lifecycle-{uuid.uuid4().hex}"
    reference = tmp_path / "reference.json"
    await asyncio.to_thread(
        subprocess.run,
        [
            "node",
            str(SYSTEM_TESTS_ROOT / "input-bundle/publish-input.mjs"),
            str(tmp_path / "producer"),
            run_id,
            str(reference),
        ],
        cwd=REPOSITORY_ROOT,
        check=True,
        timeout=30,
    )
    input_data = json.loads(
        (
            CONTRACTS_ROOT / "execution-api/v1/fixtures/issue-review-input.json"
        ).read_text()
    )
    input_data["input_bundle"] = json.loads(reference.read_text())
    request_file = tmp_path / "request.json"
    request_file.write_text(
        json.dumps({"run_id": run_id, "workflow": "issue-review", "input": input_data})
    )
    result_file = tmp_path / "result.json"
    queue = f"seam-{uuid.uuid4().hex}"
    client = await connect_temporal_client(address=temporal, namespace="default")
    with ThreadPoolExecutor(max_workers=4) as executor:
        async with Worker(
            client,
            task_queue=queue,
            workflows=[ExecutionWorkflow, IssueReviewWorkflow],
            activities=[
                prepare_execution_run_activity,
                deterministic_analysis,
                mitigate_issue_activity,
                verify_issue_activity,
                build_issue_review_result_activity,
                publish_execution_archive_activity,
            ],
            activity_executor=executor,
        ):
            process = await asyncio.create_subprocess_exec(
                "node",
                str(SYSTEM_TESTS_ROOT / "execution-lifecycle/execution-lifecycle.mjs"),
                cwd=REPOSITORY_ROOT,
                env={
                    **os.environ,
                    "NODE_ENV": "test",
                    "TEMPORAL_ADDRESS": temporal,
                    "TEMPORAL_EXECUTION_TASK_QUEUE": queue,
                    "EXECUTION_API_TOKEN": "seam-execution",
                    "EXECUTION_API_REQUEST_RETRIES": "0",
                    "TEST_DATABASE_URL": postgres["review_runs"],
                    "TEST_REQUEST_FILE": str(request_file),
                    "TEST_RESULT_FILE": str(result_file),
                },
            )
            try:
                assert await asyncio.wait_for(process.wait(), timeout=75) == 0
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
    result = json.loads(result_file.read_text())
    assert result["execution"]["status"] == "succeeded"
    assert result["workflow_result"]["api_version"] == "v1"
    assert result["artifact_storage"]["status"] == "available"
    reference = result["artifact_storage"]["artifact"]
    artifact = ArtifactReference.from_mapping(
        {key: value for key, value in reference.items() if key != "kind"}
    )
    materialize_verified_artifact_file(
        artifact,
        local_destination=tmp_path / "diagnostics.tar.zst",
        maximum_bytes=1024 * 1024,
    )
