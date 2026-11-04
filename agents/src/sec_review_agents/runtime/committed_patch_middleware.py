"""Validate committed delivery before accepting a repair response."""

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, NotRequired

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    OmitFromSchema,
    hook_config,
)
from langchain_core.messages import HumanMessage
from langgraph.channels.untracked_value import UntrackedValue
from langgraph.runtime import Runtime

from sec_review_agents.workspace.commits import build_committed_patch
from sec_review_agents.workspace.patches import (
    check_workspace_patch_applies_to_fresh_baseline,
)


class CommittedPatchState(AgentState):
    # Keep correction budget local to a graph invocation, outside model I/O.
    committed_patch_correction_attempted: NotRequired[
        Annotated[bool, UntrackedValue, OmitFromSchema(input=True, output=True)]
    ]


@dataclass
class CommittedPatchMiddleware(AgentMiddleware[CommittedPatchState, Any, Any]):
    """Reject a candidate final response and allow one in-thread commit correction.

    after_model runs before final routing, so rejection can clear the candidate
    response and return to the model while its tools and workspace remain alive.
    Empty repairs are valid except for combined-delivery synthesis.
    """

    worktree_path: Path
    baseline_commit: str
    workspace_snapshot_tar_path: Path
    require_changes: bool = False
    state_schema = CommittedPatchState

    @hook_config(can_jump_to=["model"])
    def after_model(
        self, state: CommittedPatchState, runtime: Runtime
    ) -> dict[str, Any] | None:
        if state.get("structured_response") is None:
            return None
        try:
            artifact = build_committed_patch(
                self.worktree_path, baseline_commit=self.baseline_commit
            )
            if self.require_changes and not artifact.file_changes:
                raise ValueError(
                    "Patch synthesis requires a non-empty committed repair."
                )
            error = check_workspace_patch_applies_to_fresh_baseline(
                self.workspace_snapshot_tar_path, artifact.patch_diff
            )
            if error:
                raise ValueError(error)
        except Exception as error:
            if state.get("committed_patch_correction_attempted", False):
                raise
            return {
                "jump_to": "model",
                "committed_patch_correction_attempted": True,
                "structured_response": None,
                "messages": [
                    HumanMessage(
                        content=f"Committed repair was rejected: {error}. Keep the initial commit as an ancestor of HEAD and commit a repair whose net patch applies to the original baseline. Correct the commits and return your final response again."
                    )
                ],
            }
        return None

    async def aafter_model(
        self, state: CommittedPatchState, runtime: Runtime
    ) -> dict[str, Any] | None:
        return self.after_model(state, runtime)
