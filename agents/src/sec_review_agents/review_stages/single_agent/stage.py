"""Reusable single-agent repair stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sec_review_agents.agents.single_agent.agent import (
    create_single_agent_graph,
)
from sec_review_agents.agents.single_agent.mcp import SINGLE_AGENT_MCP_TOOLS
from sec_review_agents.mcp.client import managed_mcp_tools_async
from sec_review_agents.mcp.resolver import resolve_agent_mcp_connections
from sec_review_agents.review_stages.single_agent.result import (
    build_single_agent_fix_outcome,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    bootstrap_environment,
    record_bootstrap_result,
)
from sec_review_agents.runtime.transcripts import remove_transcripts, transcript_path
from sec_review_agents.utils.files import (
    persist_text_artifact,
    reset_stage_attempt_artifacts,
)
from sec_review_agents.workspace.patches import (
    build_patch_artifact,
    normalize_declared_changed_files,
)
from sec_review_agents.workspace.snapshots import (
    restore_workspace_from_snapshot_tar,
)


async def run_single_agent_stage(
    *,
    agent_name: str,
    baseline_snapshot_tar_path: Path,
    single_agent_artifacts_path: Path,
    build_backend: Callable[[Path], Any],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
    todo_system_prompt: str,
    todo_tool_description: str,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sec-review-single-agent-") as tempdir:
        reset_stage_attempt_artifacts(
            single_agent_artifacts_path,
            filenames=("workspace.patch",),
        )
        remove_transcripts((transcript_path(single_agent_artifacts_path),))
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        transcript = transcript_path(single_agent_artifacts_path)
        backend = build_backend(workspace_path)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            record_bootstrap_result(
                single_agent_artifacts_path,
                await bootstrap_environment(
                    backend, setup_declaration_content=setup_declaration_content
                ),
            )
            # The agent package owns MCP capability selection. The stage
            # materializes those tools so their sessions span graph construction
            # and the complete invocation.
            mcp_connections = resolve_agent_mcp_connections(
                SINGLE_AGENT_MCP_TOOLS,
                backend,
            )
            async with managed_mcp_tools_async(mcp_connections) as mcp_tools:
                agent = await create_single_agent_graph(
                    agent_name=agent_name,
                    backend=backend,
                    system_prompt=system_prompt,
                    filesystem_system_prompt=filesystem_system_prompt,
                    todo_system_prompt=todo_system_prompt,
                    todo_tool_description=todo_tool_description,
                    baseline_snapshot_tar_path=baseline_snapshot_tar_path,
                    workspace_root_path=workspace_path,
                    mcp_tools=mcp_tools,
                )
                agent_output = await invoke_agent_runtime_graph(
                    agent=agent,
                    agent_name=agent_name,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    transcript_paths=(transcript,),
                )
        raw_declared_paths = agent_output.get("declared_changed_files")
        if raw_declared_paths is None:
            declared_patch_paths: list[str] = []
        elif isinstance(raw_declared_paths, list):
            declared_patch_paths = normalize_declared_changed_files(raw_declared_paths)
        else:
            raise ValueError("declared_changed_files must be a list.")
        patch_artifact = build_patch_artifact(
            workspace_path,
            include_paths=declared_patch_paths,
        )
        persist_text_artifact(
            single_agent_artifacts_path,
            "workspace.patch",
            patch_artifact["patch_diff"],
        )
        return build_single_agent_fix_outcome(
            overview=agent_output["overview"],
            verdict=agent_output["verdict"],
            validation_level=agent_output["validation_level"],
            regression_status=agent_output["regression_status"],
            target_claim=agent_output["target_claim"],
            file_changes=patch_artifact["file_changes"],
            patch_diff=patch_artifact["patch_diff"],
            residual_risks=agent_output["residual_risks"],
            self_check_notes=agent_output["self_check_notes"],
        )


__all__ = [
    "run_single_agent_stage",
]
