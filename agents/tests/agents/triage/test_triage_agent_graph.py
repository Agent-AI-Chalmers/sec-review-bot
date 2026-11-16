import json
from pathlib import Path
from unittest.mock import patch, sentinel

import pytest

from sec_review_agents.agents.discovery.model import DiscoveryCandidate
from sec_review_agents.agents.triage.agent import (
    run_repository_triage_agent as run_triage_agent,
)
from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult
from sec_review_agents.scan_stages.triage.stage import (
    REPOSITORY_TRIAGER_AGENT_NAME,
    TriageMode,
    run_repository_triage_stage,
)
from tests.repository_scan_fixtures import scan_result_fixture


@pytest.mark.asyncio
async def test_repository_triage_enables_scanner_finding_skill_without_todo() -> None:
    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.invoke_agent_runtime_graph",
            return_value=sentinel.agent,
        ),
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
        agent = await run_triage_agent(user_prompt="task", backend=sentinel.backend)

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
    assert kwargs["response_format"].schema.__name__ == "TriagePlanningDone"
    assert "context_schema" not in kwargs


@pytest.mark.asyncio
async def test_repository_triage_respects_missing_structured_response_retry_env() -> (
    None
):
    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.invoke_agent_runtime_graph",
            return_value=sentinel.agent,
        ),
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
        await run_triage_agent(user_prompt="task", backend=sentinel.backend)

    missing_structured_response_mock.assert_called_once_with(max_retries=0)


@pytest.mark.asyncio
async def test_repository_triage_single_mode_passes_explicit_runtime_inputs(
    tmp_path: Path,
) -> None:
    triage_root = tmp_path / "triage"
    phases: list[str] = []

    async def fake_agent_pass(*, phase: str, **_kwargs):
        phases.append(phase)
        if len(phases) > 1:
            return
        _kwargs["workbench_state"].create_group(
            kind="keep",
            item_ids=["candidate-a"],
            summary="A",
            category="test",
            evidence=["A"],
        )
        return

    with patch(
        "sec_review_agents.scan_stages.triage.stage._invoke_triage_agent",
        side_effect=fake_agent_pass,
    ) as pass_mock:
        result = await run_repository_triage_stage(
            triage_root=triage_root,
            discovery_result=scan_result_fixture(
                candidates=[
                    DiscoveryCandidateResult(
                        candidate_id="candidate-a",
                        candidate=DiscoveryCandidate(
                            category="xss", description="A", locations=[], evidence=[]
                        ),
                        grounding_status="grounded",
                    )
                ]
            ).discovery_result,
            triage_mode="single",
        )

    assert result.metadata.agent_run_count == 2
    assert "agent_result" not in result.model_dump()
    assert "agent_results" not in result.model_dump()
    assert pass_mock.call_args.kwargs["triage_root"] == triage_root
    assert phases == ["draft", "refinement"]
    assert json.loads((triage_root / "triage-input.json").read_text()) == {
        "summary": {"candidate_count": 1},
        "candidates": [
            {
                "candidate_id": "candidate-a",
                "category": "xss",
                "description": "A",
                "locations": [],
                "evidence": [],
                "grounding_status": "grounded",
            }
        ],
    }


@pytest.mark.asyncio
async def test_repository_triage_batched_mode_uses_explicit_runtime_inputs(
    tmp_path: Path,
) -> None:
    with patch(
        "sec_review_agents.scan_stages.triage.stage._invoke_triage_agent"
    ) as refine:
        result = await run_repository_triage_stage(
            triage_root=tmp_path / "triage",
            discovery_result=scan_result_fixture(candidates=[]).discovery_result,
            triage_mode="batched",
            max_batch_size=2,
        )
    refine.assert_not_awaited()
    assert result.metadata.agent_run_count == 0

    assert "agent_result" not in result.model_dump()
    assert "agent_results" not in result.model_dump()


@pytest.mark.asyncio
@pytest.mark.parametrize("triage_mode", ["single", "batched"])
@pytest.mark.parametrize("draft", ["valid", "repaired", "incomplete"])
async def test_triage_always_refines_once(
    tmp_path: Path, triage_mode: TriageMode, draft: str
) -> None:
    """Refine even edited drafts; reject incomplete state after that one chance to repair."""
    phases: list[str] = []

    async def fake_agent_pass(*, workbench_state, phase, **_kwargs):
        phases.append(phase)
        if (phase == "draft" and draft == "valid") or (
            phase == "refinement" and draft == "repaired"
        ):
            workbench_state.create_group(
                kind="keep",
                item_ids=["a"],
                summary="A",
                category="test",
                evidence=["A"],
            )

    candidate = DiscoveryCandidateResult(
        candidate_id="a",
        candidate=DiscoveryCandidate(
            category="xss", description="A", locations=[], evidence=[]
        ),
        grounding_status="grounded",
    )
    with patch(
        "sec_review_agents.scan_stages.triage.stage._invoke_triage_agent",
        side_effect=fake_agent_pass,
    ):
        if draft == "incomplete":
            with pytest.raises(RuntimeError, match="incomplete"):
                result = await run_repository_triage_stage(
                    triage_root=tmp_path,
                    discovery_result=scan_result_fixture(
                        candidates=[candidate]
                    ).discovery_result,
                    triage_mode=triage_mode,
                )
        else:
            result = await run_repository_triage_stage(
                triage_root=tmp_path,
                discovery_result=scan_result_fixture(
                    candidates=[candidate]
                ).discovery_result,
                triage_mode=triage_mode,
            )
            assert result.metadata.agent_run_count == len(phases)
            artifact = json.loads((tmp_path / "triage-result.json").read_text())
            assert type(result).model_validate(artifact) == result

    assert phases == ["draft", "refinement"]
    if draft == "incomplete":
        assert not (tmp_path / "triage-result.json").exists()


@pytest.mark.asyncio
async def test_batch_drafts_preserve_input_order_and_first_duplicate(
    tmp_path: Path,
) -> None:
    """ID sorting for batching must not reorder or replace model-visible candidates."""
    observed: dict[int, list[tuple[str, str]]] = {}

    async def fake_agent_pass(*, workbench_state, phase, batch_index=None, **_kwargs):
        if phase == "refinement":
            return
        assert batch_index is not None
        observed[batch_index] = [
            (
                item_id,
                workbench_state.items_by_id[item_id].candidate.candidate.description,
            )
            for item_id in workbench_state.ordered_item_ids
        ]
        workbench_state.create_groups(
            groups=[
                {
                    "kind": "keep",
                    "item_ids": workbench_state.ordered_item_ids,
                    "summary": "Batch",
                    "category": "test",
                    "evidence": ["Batch"],
                }
            ]
        )

    candidates = [
        DiscoveryCandidateResult(
            candidate_id=candidate_id,
            candidate=DiscoveryCandidate(
                category="xss", description=description, locations=[], evidence=[]
            ),
            grounding_status="grounded",
        )
        for candidate_id, description in [
            ("c", "C"),
            ("b", "first B"),
            ("a", "A"),
            (" b ", "second B"),
        ]
    ]
    with patch(
        "sec_review_agents.scan_stages.triage.stage._invoke_triage_agent",
        side_effect=fake_agent_pass,
    ):
        await run_repository_triage_stage(
            triage_root=tmp_path,
            discovery_result=scan_result_fixture(
                candidates=candidates
            ).discovery_result,
            triage_mode="batched",
            max_batch_size=3,
        )
    assert observed == {1: [("b", "first B"), ("a", "A")], 2: [("c", "C")]}
