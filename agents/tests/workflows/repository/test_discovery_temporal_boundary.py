import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError
from temporalio import workflow
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from sec_review_agents.agents.discovery.model import DiscoveryOutput
from sec_review_agents.scan_stages.discovery.input import (
    DiscoveryManifest,
    DiscoverySkippedFile,
)
from sec_review_agents.scan_stages.input import RepositoryScanScope
from sec_review_agents.scan_stages.triage.result import TriageCase
from sec_review_agents.workflows.repository.scan_result import RepositoryScanResult
from sec_review_agents.workflows.repository.workflow import (
    RepositoryDiscoveryWorkflow,
    RepositoryScanWorkflow,
    build_repository_discovery_manifest_activity,
    build_repository_discovery_result_activity,
    scan_repository_discovery_chunk_activity,
    triage_repository_activity,
    window_deletion_summary_activity,
)
from sec_review_agents.workflows.review_intent import ReviewIntent
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.prepared_input_fixtures import prepared_repository_input
from tests.repository_scan_fixtures import scan_result_fixture
from tests.temporal_test_utils import temporal_time_skipping_environment


@workflow.defn
class ScanBoundaryParentWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> RepositoryScanResult:
        result = await workflow.execute_child_workflow(
            RepositoryScanWorkflow.run, request, id=f"{request.run_id}:scan"
        )
        # This assertion runs in the parent sandbox after child-result decoding.
        assert isinstance(result.triage_result.cases[0], TriageCase)
        assert result.triage_result.metadata.batch_size is None
        return result


def prepare_manifest(tmp_path: Path) -> DiscoveryManifest:
    from sec_review_agents.scan_stages.discovery.stage import prepare_discovery_chunks

    workspace = tmp_path / "source"
    workspace.mkdir()
    (workspace / "app.py").write_text("print('ok')\n", encoding="utf-8")
    (workspace / "README.md").write_text("Example", encoding="utf-8")
    with patch(
        "sec_review_agents.scan_stages.discovery.stage.discovery_chunk_token_limits",
        return_value=(100_000, 20_000, 80_000),
    ):
        return prepare_discovery_chunks(
            workspace_root=workspace,
            scan_mode="full",
            scan_scope=RepositoryScanScope.model_validate(
                {"incremental_changed_files": [], "paths_ignore": []}
            ),
            discovery_artifacts_path=tmp_path / "discovery",
        )


@pytest.mark.asyncio
async def test_discovery_manifest_converter_preserves_nested_optional_fields(
    tmp_path: Path,
) -> None:
    manifest = prepare_manifest(tmp_path)
    manifest.skipped_files.append(
        DiscoverySkippedFile.model_validate(
            {
                "path": "large.py",
                "reason": "token-budget-exceeded",
                "size_bytes": 100,
                "token_count": 90_000,
                "hard_limit_tokens": 80_000,
            }
        )
    )
    converter = pydantic_data_converter
    assert await converter.decode(
        await converter.encode([manifest]), [DiscoveryManifest]
    ) == [manifest]

    malformed = {
        **manifest.model_dump(exclude_none=True),
        "skipped_files": [
            {
                **manifest.skipped_files[-1].model_dump(exclude_none=True),
                "token_count": "bad",
            }
        ],
    }
    with pytest.raises(ValidationError, match="skipped_files"):
        await converter.decode(await converter.encode([malformed]), [DiscoveryManifest])


@pytest.mark.asyncio
async def test_temporal_converter_rejects_missing_required_manifest_fields() -> None:
    """Incomplete payloads must fail decoding instead of reaching the scheduler."""
    converter = pydantic_data_converter
    with pytest.raises(ValidationError, match="workspace_root"):
        await converter.decode(await converter.encode([{}]), [DiscoveryManifest])


@pytest.mark.asyncio
async def test_discovery_production_activities_cross_temporal_boundary(
    tmp_path: Path,
) -> None:
    """Exercise sandboxed workflow and real activities; only the LLM is replaced."""
    manifest = prepare_manifest(tmp_path)
    snapshot = create_workspace_snapshot_tar(
        workspace_path=Path(manifest.workspace_root),
        tar_path=tmp_path / "workspace.tar",
    )
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="discovery-boundary",
        prepared_input=prepared_repository_input(
            review_intent=ReviewIntent(objective="audit", test_changes="allow"),
            artifact_root_path=str(tmp_path / "run"),
            discovery_artifacts_path=str(tmp_path / "run" / "discovery"),
            triage_artifacts_path=str(tmp_path / "run" / "triage"),
            workspace_snapshot_tar_path=str(snapshot),
            scan_mode="full",
            scan_scope=RepositoryScanScope.model_validate(
                {"incremental_changed_files": [], "paths_ignore": []}
            ),
        ),
        timeout_seconds=30,
        runtime_context={},
    )
    triage_output = scan_result_fixture(candidate_count=1, case_count=1).triage_result
    triage_agent = AsyncMock(return_value=triage_output)
    with (
        patch(
            "sec_review_agents.scan_stages.triage.agent_passes.run_repository_triage_agent",
            triage_agent,
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.stage.discovery_chunk_token_limits",
            return_value=(100_000, 20_000, 80_000),
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.stage.run_repository_discovery_agent",
            new=AsyncMock(
                return_value=DiscoveryOutput.model_validate(
                    {
                        "candidates": [
                            {
                                "category": "example",
                                "description": "Anchored candidate",
                                "locations": [{"file": "app.py", "label": "call"}],
                                "evidence": ["print('ok')"],
                            }
                        ]
                    }
                )
            ),
        ),
    ):
        async with temporal_time_skipping_environment() as env:
            with ThreadPoolExecutor(max_workers=2) as executor:
                async with Worker(
                    env.client,
                    task_queue="discovery-boundary",
                    workflows=[
                        RepositoryDiscoveryWorkflow,
                        RepositoryScanWorkflow,
                        ScanBoundaryParentWorkflow,
                    ],
                    activities=[
                        triage_repository_activity,
                        window_deletion_summary_activity,
                        build_repository_discovery_manifest_activity,
                        scan_repository_discovery_chunk_activity,
                        build_repository_discovery_result_activity,
                    ],
                    activity_executor=executor,
                ):
                    scan_result = await asyncio.wait_for(
                        env.client.execute_workflow(
                            ScanBoundaryParentWorkflow.run,
                            request,
                            id="discovery-boundary",
                            task_queue="discovery-boundary",
                        ),
                        timeout=45,
                    )
    assert isinstance(scan_result, RepositoryScanResult)
    assert scan_result.triage_result == triage_output
    assert scan_result.deleted_file_count == 0
    assert scan_result.deletion_review_skipped is False
    result = scan_result.discovery_result
    assert result.counts.model_dump() == {
        "scannable_file_count": 1,
        "scanned_file_count": 1,
        "skipped_file_count": 1,
        "candidate_count": 1,
    }
    candidate = result.candidates[0]
    from sec_review_agents.agents.discovery.model import DiscoveryLocation
    from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult

    assert isinstance(candidate, DiscoveryCandidateResult)
    assert isinstance(candidate.candidate.locations[0], DiscoveryLocation)
    artifact = json.loads(
        (tmp_path / "run" / "discovery" / "discovery-result.json").read_text()
    )
    assert artifact["candidates"] == [
        candidate.model_dump(mode="json", exclude_none=True)
    ]
    assert "line" not in artifact["candidates"][0]["candidate"]["locations"][0]
    assert candidate.grounding_status == "grounded"
    assert candidate.candidate.evidence == ["print('ok')"]
    assert [
        location.model_dump(exclude_none=True)
        for location in candidate.candidate.locations
    ] == [{"file": "app.py", "label": "call"}]
    assert triage_agent.call_args.kwargs["triage_candidates"] == result.candidates
    assert isinstance(
        triage_agent.call_args.kwargs["triage_candidates"][0], DiscoveryCandidateResult
    )
    assert result.files[0].path == "app.py"
    assert result.skipped_files[0].path == "README.md"


@pytest.mark.asyncio
async def test_unreadable_chunk_still_has_complete_aggregation_result(
    tmp_path: Path,
) -> None:
    from sec_review_agents.scan_stages.discovery.stage import scan_discovery_chunk

    manifest = prepare_manifest(tmp_path)
    (Path(manifest.workspace_root) / "app.py").unlink()
    chunk_result = await scan_discovery_chunk(
        chunk=manifest.chunks[0], root=Path(manifest.workspace_root)
    )
    converter = pydantic_data_converter
    from sec_review_agents.scan_stages.discovery.result import DiscoveryChunkResult

    decoded = await converter.decode(
        await converter.encode([chunk_result]), [DiscoveryChunkResult]
    )
    assert decoded == [chunk_result]
    result = build_repository_discovery_result_activity(manifest, [chunk_result])
    assert result.counts.scanned_file_count == 0
    assert result.counts.skipped_file_count == 2
    assert result.candidates == []


@pytest.mark.asyncio
async def test_incomplete_chunk_result_cannot_be_reported_as_empty_success(
    tmp_path: Path,
) -> None:
    """Reject incomplete activity results before they can look like an empty scan."""
    from sec_review_agents.scan_stages.discovery.result import DiscoveryChunkResult

    manifest = prepare_manifest(tmp_path)
    converter = pydantic_data_converter
    with pytest.raises(ValidationError, match="file_candidates"):
        await converter.decode(
            await converter.encode([{"chunk_id": manifest.chunks[0].chunk_id}]),
            [DiscoveryChunkResult],
        )
