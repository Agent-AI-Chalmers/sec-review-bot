import json
from pathlib import Path
from unittest.mock import patch, sentinel

import pytest

from sec_review_agents.agents.triage.agent import (
    create_repository_triage_agent_graph,
)
from sec_review_agents.scan_stages.triage.agent_passes import (
    run_repository_triage_agent,
)
from sec_review_agents.scan_stages.triage.stage import REPOSITORY_TRIAGER_AGENT_NAME


@pytest.mark.asyncio
async def test_repository_triage_enables_scanner_finding_skill_without_todo() -> None:
    with (
        patch(
            "sec_review_agents.agents.triage.agent.SkillsMiddleware",
            return_value=sentinel.skills_middleware,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.create_filesystem_middleware",
            return_value=sentinel.filesystem_middleware,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.create_chat_model",
            return_value=sentinel.model,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.build_repository_triage_system_prompt",
            return_value="base prompt",
        ),
        patch(
            "sec_review_agents.agents.triage.agent.create_summarization_middleware",
            return_value=sentinel.summarization_middleware,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.PatchToolCallsMiddleware",
            return_value=sentinel.patch_tool_calls_middleware,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.MissingStructuredResponseMiddleware",
            return_value=sentinel.missing_structured_response_middleware,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.ModelTurnDiagnosticsMiddleware",
            return_value=sentinel.diagnostics_middleware,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent",
            return_value=sentinel.agent,
        ) as create_mock,
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=5,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.tracing_configured",
            return_value=True,
        ),
    ):
        agent = await create_repository_triage_agent_graph(backend=sentinel.backend)

    assert agent is sentinel.agent
    kwargs = create_mock.call_args.kwargs
    assert kwargs["middleware"] == [
        sentinel.missing_structured_response_middleware,
        sentinel.skills_middleware,
        sentinel.filesystem_middleware,
        sentinel.summarization_middleware,
        sentinel.patch_tool_calls_middleware,
        sentinel.diagnostics_middleware,
    ]
    assert kwargs["system_prompt"] == "base prompt"
    assert kwargs["name"] == REPOSITORY_TRIAGER_AGENT_NAME
    assert kwargs["response_format"].__name__ == "TriagePlanningDone"
    assert "context_schema" not in kwargs


@pytest.mark.asyncio
async def test_repository_triage_respects_missing_structured_response_retry_env() -> (
    None
):
    with (
        patch.dict(
            "os.environ",
            {"AGENT_MISSING_STRUCTURED_RESPONSE_MAX_RETRIES": "0"},
            clear=False,
        ),
        patch("sec_review_agents.agents.triage.agent.SkillsMiddleware"),
        patch("sec_review_agents.agents.triage.agent.create_filesystem_middleware"),
        patch(
            "sec_review_agents.agents.triage.agent.create_chat_model",
            return_value=sentinel.model,
        ),
        patch(
            "sec_review_agents.agents.triage.agent.build_repository_triage_system_prompt",
            return_value="base prompt",
        ),
        patch("sec_review_agents.agents.triage.agent.create_summarization_middleware"),
        patch(
            "sec_review_agents.agents.triage.agent.MissingStructuredResponseMiddleware",
            return_value=sentinel.missing_structured_response_middleware,
        ) as missing_structured_response_mock,
        patch("sec_review_agents.agents.triage.agent.ModelTurnDiagnosticsMiddleware"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent",
            return_value=sentinel.agent,
        ),
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=5,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.tracing_configured",
            return_value=True,
        ),
    ):
        await create_repository_triage_agent_graph(backend=sentinel.backend)

    missing_structured_response_mock.assert_called_once_with(max_retries=0)


@pytest.mark.asyncio
async def test_repository_triage_single_mode_passes_explicit_runtime_inputs(
    tmp_path: Path,
) -> None:
    triage_root = tmp_path / "triage"
    pass_metas: list[dict | None] = []

    async def fake_agent_pass(*, pass_meta: dict | None = None, **_kwargs):
        pass_metas.append(pass_meta)
        _kwargs["workbench_state"].create_group(
            kind="keep",
            item_ids=["candidate-a"],
            summary="A",
            category="test",
            evidence=["A"],
        )
        return {"passIndex": len(pass_metas) - 1}

    with patch(
        "sec_review_agents.scan_stages.triage.agent_passes._run_repository_triage_agent_pass",
        side_effect=fake_agent_pass,
    ) as pass_mock:
        result = await run_repository_triage_agent(
            triage_root=triage_root,
            triage_candidates=[{"candidate_id": "candidate-a", "description": "A"}],
            max_passes=2,
            triage_mode="single",
        )

    assert result["agent_results"] == [{"passIndex": 0}]
    assert pass_mock.call_args.kwargs["triage_root"] == triage_root
    assert pass_metas == [None]
    assert json.loads((triage_root / "triage-input.json").read_text()) == {
        "summary": {"candidate_count": 1},
        "candidates": [{"candidate_id": "candidate-a", "description": "A"}],
    }


@pytest.mark.asyncio
async def test_repository_triage_batched_mode_uses_explicit_runtime_inputs(
    tmp_path: Path,
) -> None:
    result = await run_repository_triage_agent(
        triage_root=tmp_path / "triage",
        triage_candidates=[],
        max_passes=1,
        triage_mode="batched",
        max_batch_size=2,
    )

    assert result["agent_results"] == []
