import json

import pytest
from langchain.agents import create_agent
from langchain.agents.structured_output import ProviderStrategyBinding, ToolStrategy
from langchain_core.messages import AIMessage
from pydantic import ValidationError

from sec_review_agents.agents.discovery.model import DiscoveryCandidate, DiscoveryOutput
from tests.runtime.fake_chat_models import (
    ToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)


def candidate_payload() -> dict:
    return {
        "category": "injection",
        "description": "Untrusted input reaches a query",
        "locations": [{"file": "app.py", "label": "query"}],
        "evidence": ["execute(query)"],
    }


@pytest.mark.parametrize("field", ["locations", "evidence"])
def test_output_requires_support_while_candidate_allows_filtered_content(field) -> None:
    candidate = DiscoveryCandidate.model_validate(candidate_payload() | {field: []})
    with pytest.raises(ValidationError, match=rf"candidates\[0\].{field}"):
        DiscoveryOutput(candidates=[candidate])
    assert DiscoveryOutput(candidates=[]).candidates == []


def test_candidate_schema_accepts_filtered_content_without_stage_metadata() -> None:
    """Nonempty support is an output-boundary rule, not a shared content constraint."""
    properties = DiscoveryCandidate.model_json_schema()["properties"]
    assert properties["evidence"]["items"]["minLength"] == 1
    assert "minItems" not in properties["evidence"]
    assert "minItems" not in properties["locations"]
    assert "candidate_id" not in properties
    assert "grounding_status" not in properties


@pytest.mark.asyncio
async def test_tool_output_retries_empty_candidate_support() -> None:
    invalid = {"candidates": [candidate_payload() | {"evidence": []}]}
    valid = {"candidates": [candidate_payload()]}
    model = ToolCallingFakeMessagesListChatModel(
        responses=[
            structured_tool_call_message(DiscoveryOutput, invalid, call_id="invalid"),
            structured_tool_call_message(DiscoveryOutput, valid, call_id="valid"),
        ]
    )
    graph = create_agent(
        model=model, tools=[], response_format=ToolStrategy(DiscoveryOutput)
    )
    result = await graph.ainvoke(
        {"messages": [{"role": "user", "content": "Discover"}]}
    )
    assert result["structured_response"] == DiscoveryOutput.model_validate(valid)
    assert any(
        message.type == "tool"
        and message.tool_call_id == "invalid"
        and "candidates[0].evidence" in message.content
        for message in result["messages"]
    )


def test_native_provider_parser_rejects_empty_candidate_support() -> None:
    """Provider schema no longer carries minItems; local validation still rejects empties."""
    binding = ProviderStrategyBinding(schema=DiscoveryOutput, schema_kind="pydantic")
    with pytest.raises(ValueError, match=r"candidates\[0\].evidence"):
        binding.parse(
            AIMessage(
                content=json.dumps(
                    {"candidates": [candidate_payload() | {"evidence": []}]}
                )
            )
        )


@pytest.mark.parametrize("snippet", ["", " \t\n "])
def test_candidate_rejects_blank_evidence_entries(snippet: str) -> None:
    with pytest.raises(ValidationError) as error:
        DiscoveryCandidate.model_validate(candidate_payload() | {"evidence": [snippet]})
    assert error.value.errors()[0]["loc"] == ("evidence", 0)


def test_candidate_trims_evidence_without_changing_internal_whitespace() -> None:
    snippet = "if user:\n    execute(query)"
    candidate = DiscoveryCandidate.model_validate(
        candidate_payload() | {"evidence": [f" \n{snippet}\n "]}
    )
    assert candidate.evidence == [snippet]
