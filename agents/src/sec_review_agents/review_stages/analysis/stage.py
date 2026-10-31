"""Reusable analysis stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path

from sec_review_agents.agents.analysis.agent import (
    run_analysis_agent,
)
from sec_review_agents.filesystem.backend_factory import (
    BackendConfig,
    create_backend_with_path_views,
)
from sec_review_agents.memory.runtime_view import materialized_memory_view
from sec_review_agents.review_stages.analysis.result import (
    AnalysisStageResult,
)
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    bootstrap_environment,
    record_bootstrap_result,
)
from sec_review_agents.runtime.trajectories import remove_trajectories, trajectory_path
from sec_review_agents.utils.files import (
    persist_json_artifact,
    remove_json_artifacts,
)
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


#########################################################################
# ====================== Stage Execution =================================
#########################################################################
async def run_analysis_stage(
    *,
    analyzer_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    agent_name: str,
    baseline_snapshot_tar_path: Path,
    build_backend_config: Callable[[Path], BackendConfig],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
    setup_declaration_content: str | None = None,
) -> AnalysisStageResult:
    # The backend mounts both resources, so their lifetimes must cover backend
    # construction, graph construction, and the complete agent invocation.
    with (
        tempfile.TemporaryDirectory(prefix="sec-review-analyzer-") as tempdir,
        materialized_memory_view() as memory_path_view,
    ):
        reset_analysis_artifacts(
            analyzer_artifacts_path=analyzer_artifacts_path,
        )
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        trajectory_paths = prepare_analysis_trajectory(
            analyzer_artifacts_path=analyzer_artifacts_path,
            published_trajectory_path=published_trajectory_path,
        )
        config = build_backend_config(workspace_path)
        if memory_path_view is not None:
            config["path_views"].append(memory_path_view)
        backend = create_backend_with_path_views(**config)
        async with amanaged_backend(backend):
            record_bootstrap_result(
                analyzer_artifacts_path,
                await bootstrap_environment(
                    backend, setup_declaration_content=setup_declaration_content
                ),
            )
            agent_output = await run_analysis_agent(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
                user_prompt=user_prompt,
                trajectory_paths=trajectory_paths,
                memory_enabled=memory_path_view is not None,
            )
        result = AnalysisStageResult(
            overview=agent_output.overview,
            narratives=agent_output.narratives,
            verdict=agent_output.overall_verdict,
        )
        persist_analysis_stage_result(
            analyzer_artifacts_path=analyzer_artifacts_path,
            result=result,
        )
        return result


def reset_analysis_artifacts(*, analyzer_artifacts_path: Path) -> None:
    remove_json_artifacts(analyzer_artifacts_path, ("analysis-result",))
    remove_trajectories((trajectory_path(analyzer_artifacts_path),))


def prepare_analysis_trajectory(
    *,
    analyzer_artifacts_path: Path,
    published_trajectory_path: Path | None,
) -> tuple[Path, ...]:
    local_trajectory_path = trajectory_path(analyzer_artifacts_path)
    if published_trajectory_path is None:
        return (local_trajectory_path,)

    published_trajectory_path.unlink(missing_ok=True)
    return (local_trajectory_path, published_trajectory_path)


def persist_analysis_stage_result(
    *,
    analyzer_artifacts_path: Path,
    result: AnalysisStageResult,
) -> None:
    """Persist an already-built analysis result."""
    persist_json_artifact(
        analyzer_artifacts_path,
        "analysis-result",
        result.model_dump(mode="json", by_alias=True),
    )


__all__ = [
    "run_analysis_stage",
]
