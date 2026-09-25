"""Reusable analysis stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis.agent import (
    create_analysis_agent_graph,
)
from sec_review_agents.review_stages.analysis.result import build_analysis_stage_result
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend
from sec_review_agents.utils.files import persist_json
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


#########################################################################
# ====================== Stage Execution =================================
#########################################################################
async def run_analysis_stage(
    *,
    analyzer_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    agent_name: str,
    baseline_snapshot_tar_path: Path,
    build_backend: Callable[[Path], Any],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sec-review-analyzer-") as tempdir:
        reset_analysis_artifacts(
            analyzer_artifacts_path=analyzer_artifacts_path,
        )
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        transcript_paths = prepare_analysis_transcript(
            analyzer_artifacts_path=analyzer_artifacts_path,
            published_transcript_path=published_transcript_path,
        )
        backend = build_backend(workspace_path)
        with managed_backend(backend):
            agent_graph = await create_analysis_agent_graph(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
            )
            agent_output = await invoke_agent_runtime_graph(
                agent=agent_graph,
                agent_name=agent_name,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                transcript_paths=transcript_paths,
            )
        return persist_analysis_stage_result(
            agent_output=agent_output,
            analyzer_artifacts_path=analyzer_artifacts_path,
        )


def reset_analysis_artifacts(*, analyzer_artifacts_path: Path) -> None:
    reset_stage_attempt_artifacts(
        analyzer_artifacts_path,
        filenames=("analysis-result.json", "transcript.json"),
    )


def prepare_analysis_transcript(
    *,
    analyzer_artifacts_path: Path,
    published_transcript_path: Path | None,
) -> tuple[Path, ...]:
    local_transcript_path = analyzer_artifacts_path / "transcript.json"
    if published_transcript_path is None:
        return (local_transcript_path,)

    published_transcript_path.unlink(missing_ok=True)
    return (local_transcript_path, published_transcript_path)


def persist_analysis_stage_result(
    *,
    agent_output: dict[str, Any],
    analyzer_artifacts_path: Path,
) -> dict[str, Any]:
    result = build_analysis_stage_result(
        overview=agent_output["overview"],
        narratives=agent_output["narratives"],
        verdict=agent_output["overall_verdict"],
    )
    persist_json(
        analyzer_artifacts_path,
        "analysis-result.json",
        result,
    )
    return result


__all__ = [
    "run_analysis_stage",
]
