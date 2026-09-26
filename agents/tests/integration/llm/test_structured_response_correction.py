from pathlib import Path

import pytest
from langchain.agents import create_agent
from pydantic import BaseModel, Field

from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.changed_files_acceptance_middleware import (
    ChangedFilesAcceptanceMiddleware,
)
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import llm_probe
from tests.review_stages.stages.test_mitigation_changed_files_acceptance import (
    _baseline_snapshot,
    _copy_repo,
    _create_repo,
)


class PatchClaimProbeOutput(BaseModel):
    status: str
    declared_changed_files: list[str] = Field()
    rationale: str


PROBE = llm_probe(
    run_env="RUN_LLM_STRUCTURED_CORRECTION_INTEGRATION",
    description="real LLM structured correction probe",
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_llm_can_correct_candidate_structured_response_in_same_thread(
    tmp_path: Path,
) -> None:
    deployment_override = llm_test_deployment()
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    _create_repo(
        source_workspace,
        {
            "a.txt": "old\n",
            "b.txt": "old\n",
        },
    )
    _copy_repo(source_workspace, workspace)
    (workspace / "a.txt").write_text("new\n", encoding="utf-8")
    agent = create_agent(
        model=create_chat_model(
            agent_name="structured-correction-probe",
            deployment_override=deployment_override,
        ),
        tools=[],
        response_format=PatchClaimProbeOutput,
        system_prompt=(
            "You are testing structured-output correction behavior. "
            "Return only the configured structured response."
        ),
        middleware=[
            ChangedFilesAcceptanceMiddleware(
                worktree_path=workspace,
                baseline_snapshot_tar_path=_baseline_snapshot(
                    local_root,
                    tmp_path / "artifacts" / "run-1",
                ),
            )
        ],
    )
    result = await invoke_agent_runtime_graph(
        agent=agent,
        agent_name="structured-correction-probe",
        system_prompt="Return only the configured structured response.",
        user_prompt=(
            "For this first response, intentionally return status='applied', "
            'declared_changed_files exactly ["b.txt"], and a short rationale. '
            "Do not mention a.txt yet."
        ),
        transcript_paths=(tmp_path / "transcript.json",),
    )

    assert result["declared_changed_files"] == ["a.txt"]
