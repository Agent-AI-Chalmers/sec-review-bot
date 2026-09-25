from pathlib import Path
from typing import Any

import pytest

from sec_review_agents.workflows.issue.workflow import mitigate_issue_activity


@pytest.mark.asyncio
async def test_mitigation_activity_accepts_serialized_artifact_root(
    tmp_path: Path,
) -> None:
    """Activity inputs cross a serialization boundary with string paths."""
    artifact_root = tmp_path / "artifacts"
    prepared_input: dict[str, Any] = {
        "artifact_root_path": str(artifact_root),
        "artifact_paths": {"mitigator": str(artifact_root / "mitigator")},
        "review_intent": {"objective": "audit"},
    }

    result = await mitigate_issue_activity(
        prepared_input=prepared_input,
        analysis_result={"narratives": []},
        retry_context=None,
        runtime_context={},
    )

    assert result["changed_files"] == []
    assert (artifact_root / "mitigator" / "mitigation-result.json").is_file()
