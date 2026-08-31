import json
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sec_review_agents.workflows.issue.analysis import analyze_issue
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.integration.llm.probe_helpers import llm_probe

ISSUE_LLM_PROBE = llm_probe(
    run_env="RUN_LLM_ISSUE_REVIEW_INTEGRATION",
    description="real LLM issue-review probes",
    requires_deployment=False,
)
ISSUE_LLM_ENABLED = ISSUE_LLM_PROBE.enabled()
ISSUE_LLM_SKIP_REASON = ISSUE_LLM_PROBE.skip_reason()


def confirmed_narratives(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        narrative
        for narrative in result.get("narratives", [])
        if isinstance(narrative, dict)
        and narrative.get("verdict") == "confirmed-vulnerability"
    ]


def confirmed_findings(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        narrative
        for narrative in result.get("narratives", [])
        if isinstance(narrative, dict)
        and narrative.get("verdict") in {"confirmed-vulnerability", "confirmed-defect"}
    ]


def non_confirmed_narratives(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        narrative
        for narrative in result.get("narratives", [])
        if isinstance(narrative, dict)
        and narrative.get("verdict")
        not in {"confirmed-vulnerability", "confirmed-defect"}
    ]


def narrative_text(narrative: dict[str, Any]) -> str:
    return json.dumps(narrative, sort_keys=True).lower()


def confirmed_text(result: Mapping[str, Any]) -> str:
    return "\n".join(narrative_text(item) for item in confirmed_narratives(result))


def narrative_label_text(narrative: dict[str, Any]) -> str:
    return json.dumps(
        {
            "title": narrative.get("title"),
            "vulnerability_type": narrative.get("vulnerability_type"),
            "cwe_mapping": narrative.get("cwe_mapping"),
        },
        sort_keys=True,
    ).lower()


async def analyze_issue_case(
    *,
    workspace_files: dict[str, str],
    issue: dict[str, str],
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tempdir:
        root = Path(tempdir)
        workspace = root / "workspace"
        history = root / "history"
        analyzer_artifacts = root / "artifacts" / "analyzer"

        history.mkdir(parents=True)
        analyzer_artifacts.mkdir(parents=True)
        for relative_path, contents in workspace_files.items():
            file_path = workspace / relative_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(contents, encoding="utf-8")
        snapshot_tar = root / "workspace.snapshot.tar"
        create_workspace_snapshot_tar(
            workspace_path=workspace,
            tar_path=snapshot_tar,
        )

        with patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ):
            result = await analyze_issue(
                issue=issue,
                workspace_snapshot_tar_path=snapshot_tar,
                history_path=history,
                analyzer_artifacts_path=analyzer_artifacts,
                review_objective="audit",
            )

        print(json.dumps(result, indent=2, sort_keys=True))
        return result
