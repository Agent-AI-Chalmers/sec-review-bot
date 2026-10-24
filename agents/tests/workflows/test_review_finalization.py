from unittest.mock import Mock

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.workflows import review_finalization
from sec_review_agents.workflows.review_finalization import (
    RunDiagnosticPublicationRequest,
    finalize_review_run,
)


def _published() -> dict[str, object]:
    reference = ArtifactReference(
        uri="s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )
    return {
        "diagnostic_bundle": reference.as_dict(),
        "artifact_storage": {
            "status": "available",
            "artifact": {"kind": "diagnostic_bundle", **reference.as_dict()},
        },
        "review_unit_ids": ["case-a", "case-b"],
    }


@pytest.mark.asyncio
async def test_finalization_returns_the_published_run_artifact(monkeypatch) -> None:
    execute_activity = Mock(return_value=_published())

    async def fake_execute_activity(*args, **kwargs):
        return execute_activity(*args, **kwargs)

    monkeypatch.setattr(
        review_finalization.workflow,
        "execute_activity",
        fake_execute_activity,
    )

    request = RunDiagnosticPublicationRequest(
        run_id="run-1",
        artifact_root_path="/tmp/run-1",
        review_units=[],
        result={},
        timeout_seconds=30,
        publication="managed",
    )
    assert await finalize_review_run(request) == _published()
    assert execute_activity.call_args.args == (
        review_finalization.publish_run_diagnostic_activity,
        request,
    )


@pytest.mark.asyncio
async def test_finalization_failure_prevents_review_success(monkeypatch) -> None:
    async def fail(*_args, **_kwargs):
        raise RuntimeError("storage unavailable")

    monkeypatch.setattr(review_finalization.workflow, "execute_activity", fail)

    with pytest.raises(RuntimeError, match="storage unavailable"):
        await finalize_review_run(
            RunDiagnosticPublicationRequest(
                run_id="run-1",
                artifact_root_path="/tmp/run-1",
                review_units=[],
                result={},
                timeout_seconds=30,
                publication="managed",
            )
        )
