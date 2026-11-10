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
    Empty repairs are accepted unless the caller supplies
    `empty_repair_correction`: then an empty commit is rejected once with that
    caller-owned message. A response that is still empty after the correction is
    returned to the caller, which owns the empty outcome and can report the
    agent's own explanation.
    """

    worktree_path: Path
    baseline_commit: str
    workspace_snapshot_tar_path: Path
    empty_repair_correction: str | None = None
    state_schema = CommittedPatchState

    @hook_config(can_jump_to=["model"])
    def after_model(
        self, state: CommittedPatchState, runtime: Runtime
    ) -> dict[str, Any] | None:
        if state.get("structured_response") is None:
            return None
        correction_attempted = state.get("committed_patch_correction_attempted", False)
        try:
            artifact = build_committed_patch(
                self.worktree_path, baseline_commit=self.baseline_commit
            )
            if self.empty_repair_correction is not None and not artifact.file_changes:
                if correction_attempted:
                    return None
                return self._correction(self.empty_repair_correction)
            error = check_workspace_patch_applies_to_fresh_baseline(
                self.workspace_snapshot_tar_path, artifact.patch_diff
            )
            if error:
                raise ValueError(error)
        except Exception as error:
            if correction_attempted:
                raise
            return self._correction(
                f"Committed repair was rejected: {error}. Keep the initial commit as an ancestor of HEAD and commit a repair whose net patch applies to the original baseline. Correct the commits and return your final response again."
            )
        return None

    def _correction(self, message: str) -> dict[str, Any]:
        return {
            "jump_to": "model",
            "committed_patch_correction_attempted": True,
            "structured_response": None,
            "messages": [HumanMessage(content=message)],
        }

    async def aafter_model(
        self, state: CommittedPatchState, runtime: Runtime
    ) -> dict[str, Any] | None:
        return self.after_model(state, runtime)
