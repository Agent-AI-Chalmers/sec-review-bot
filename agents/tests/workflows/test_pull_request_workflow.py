from pathlib import Path
from typing import Any

import pytest

from sec_review_agents.workflows.pull_request.workflow import (
    mitigate_pull_request_activity,
)


def _prepared_input(artifact_root: Path) -> dict[str, Any]:
    return {
        "artifact_root_path": str(artifact_root),
        "artifact_paths": {"mitigator": str(artifact_root / "mitigator")},
        "bundle_paths": {
            "workspace_snapshot_tar_path": str(artifact_root / "workspace.tar"),
            "history_path": str(artifact_root / "history"),
            "incremental_window_path": str(artifact_root / "incremental.json"),
        },
        "pr": {},
        "review_intent": {"objective": "audit"},
    }


@pytest.mark.asyncio
async def test_mitigation_activity_skip_accepts_serialized_artifact_root(
    tmp_path: Path,
) -> None:
    """Activity inputs cross a serialization boundary with string paths."""
    artifact_root = tmp_path / "artifacts"

    result = await mitigate_pull_request_activity(
        prepared_input=_prepared_input(artifact_root),
        analysis_result={"narratives": []},
        retry_context=None,
        runtime_context={},
    )

    assert result["changed_files"] == []
    assert (artifact_root / "mitigator" / "mitigation-result.json").is_file()


@pytest.mark.asyncio
async def test_mitigation_activity_run_accepts_serialized_artifact_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifact_root = tmp_path / "artifacts"
    captured: dict[str, Any] = {}

    async def fake_mitigate_pull_request(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"changed_files": []}

    monkeypatch.setattr(
        "sec_review_agents.workflows.pull_request.mitigation.mitigate_pull_request",
        fake_mitigate_pull_request,
    )

    result = await mitigate_pull_request_activity(
        prepared_input=_prepared_input(artifact_root),
        analysis_result={
            "narratives": [{"verdict": "confirmed-defect"}],
        },
        retry_context=None,
        runtime_context={},
    )

    assert result == {"changed_files": []}
    assert captured["workspace_snapshot_tar_path"] == artifact_root / "workspace.tar"
    assert captured["history_path"] == artifact_root / "history"
    assert captured["incremental_window_path"] == artifact_root / "incremental.json"
    assert captured["mitigator_artifacts_path"] == artifact_root / "mitigator"
    assert captured["published_transcript_path"] == (
        artifact_root / "transcripts" / "0001-review" / "0002-mitigator-initial.json"
    )
