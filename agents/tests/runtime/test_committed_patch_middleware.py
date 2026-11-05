from pathlib import Path
from typing import Any, cast
from unittest.mock import Mock

import pytest
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime
from pydantic import BaseModel, Field

from sec_review_agents.runtime.committed_patch_middleware import (
    CommittedPatchMiddleware,
    CommittedPatchState,
)
from sec_review_agents.workspace.patches import PatchArtifact
from tests.runtime.fake_chat_models import (
    RecordingToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)


def test_retries_invalid_commits_once_then_fails(tmp_path: Path, monkeypatch) -> None:
    middleware = CommittedPatchMiddleware(
        tmp_path, "baseline", tmp_path / "baseline.tar"
    )
    build = Mock(side_effect=RuntimeError("unrelated history"))
    monkeypatch.setattr(
        "sec_review_agents.runtime.committed_patch_middleware.build_committed_patch",
        build,
    )
    state = cast(CommittedPatchState, {"messages": [], "structured_response": object()})
    runtime = cast(Runtime[Any], None)
    correction = middleware.after_model(state, runtime)
    assert correction is not None
    assert correction["jump_to"] == "model"
    assert correction["structured_response"] is None
    state["committed_patch_correction_attempted"] = correction[
        "committed_patch_correction_attempted"
    ]
    with pytest.raises(RuntimeError, match="unrelated history"):
        middleware.after_model(state, runtime)


def test_checks_committed_patch_against_original_snapshot(
    tmp_path: Path, monkeypatch
) -> None:
    middleware = CommittedPatchMiddleware(
        tmp_path, "baseline", tmp_path / "baseline.tar"
    )
    monkeypatch.setattr(
        "sec_review_agents.runtime.committed_patch_middleware.build_committed_patch",
        Mock(return_value=PatchArtifact(patch_diff="patch", file_changes=[])),
    )
    check = Mock(return_value=None)
    monkeypatch.setattr(
        "sec_review_agents.runtime.committed_patch_middleware.check_workspace_patch_applies_to_fresh_baseline",
        check,
    )
    state = cast(CommittedPatchState, {"messages": [], "structured_response": object()})
    assert middleware.after_model(state, cast(Runtime[Any], None)) is None
    check.assert_called_once_with(tmp_path / "baseline.tar", "patch")


@pytest.mark.parametrize("require_changes", [False, True])
def test_empty_commit_result_depends_on_stage_policy(
    tmp_path: Path, monkeypatch, require_changes: bool
) -> None:
    middleware = CommittedPatchMiddleware(
        tmp_path, "baseline", tmp_path / "baseline.tar", require_changes=require_changes
    )
    monkeypatch.setattr(
        "sec_review_agents.runtime.committed_patch_middleware.build_committed_patch",
        Mock(return_value=PatchArtifact(patch_diff="", file_changes=[])),
    )
    check = Mock(return_value=None)
    monkeypatch.setattr(
        "sec_review_agents.runtime.committed_patch_middleware.check_workspace_patch_applies_to_fresh_baseline",
        check,
    )
    state = cast(CommittedPatchState, {"messages": [], "structured_response": object()})
    correction = middleware.after_model(state, cast(Runtime[Any], None))
    if require_changes:
        assert correction is not None
        assert correction["jump_to"] == "model"
        state["committed_patch_correction_attempted"] = correction[
            "committed_patch_correction_attempted"
        ]
        with pytest.raises(ValueError, match="non-empty committed repair"):
            middleware.after_model(state, cast(Runtime[Any], None))
        check.assert_not_called()
    else:
        assert correction is None
        check.assert_called_once()


class PatchClaimProbeOutput(BaseModel):
    status: str
    changed_files: list[str] = Field()
    rationale: str


def test_committed_patch_acceptance_retries_in_one_invoke(
    tmp_path, monkeypatch
) -> None:
    build = Mock(
        side_effect=[
            ValueError("invalid commit"),
            PatchArtifact(patch_diff="", file_changes=[]),
        ]
    )
    monkeypatch.setattr(
        "sec_review_agents.runtime.committed_patch_middleware.build_committed_patch",
        build,
    )
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "candidate"},
                call_id="first",
            ),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "corrected"},
                call_id="second",
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[],
        response_format=PatchClaimProbeOutput,
        middleware=[
            CommittedPatchMiddleware(tmp_path, "baseline", tmp_path / "baseline.tar")
        ],
    )
    result = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})
    assert result["structured_response"].rationale == "corrected"
    assert len(model.message_batches) == 2
    assert build.call_count == 2
    # Reusing the compiled graph starts a fresh correction budget.
    build.side_effect = [
        ValueError("invalid commit"),
        PatchArtifact(patch_diff="", file_changes=[]),
    ]
    again = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})
    assert again["structured_response"].rationale == "corrected"
    assert build.call_count == 4
