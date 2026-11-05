import json
import random
import sys
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import BaseModel, Field

from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
)
from tests.runtime.fake_chat_models import (
    RecordingToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)


class PatchClaimProbeOutput(BaseModel):
    status: str
    changed_files: list[str] = Field()
    rationale: str


def lookup_evidence(query: str) -> str:
    """Look up evidence for a test query."""

    return f"evidence for {query}"


def test_missing_structured_response_middleware_keeps_tool_agent_in_one_invoke() -> (
    None
):
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(content="I found the answer but forgot the schema."),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {
                    "status": "applied",
                    "changed_files": ["a.txt"],
                    "rationale": "middleware requested structured response",
                },
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[lookup_evidence],
        response_format=PatchClaimProbeOutput,
        system_prompt="Return the configured structured response.",
        middleware=[MissingStructuredResponseMiddleware()],
    )
    result = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})

    structured = result["structured_response"]
    assert structured.changed_files == ["a.txt"]
    assert len(model.message_batches) == 2
    assert model.message_batches[0][-1].content == "Return a patch claim."
    assert (
        "did not include the required structured response"
        in model.message_batches[1][-1].content
    )


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        ('{"rationale":"bad ' + chr(92) + 'd"}', "Invalid"),
        ('{"rationale":"' + "x" * 10000 + chr(92) + 'evil"}', "Invalid"),
        ("[]", "not list"),
        ('{"rationale":"valid"}', "tool parser rejected"),
    ],
)
@pytest.mark.parametrize("tools", [[], [lookup_evidence]])
def test_invalid_structured_tool_arguments_are_retried(
    tools: list[Any], arguments: str, expected: str
) -> None:
    """Malformed JSON must reach recovery before the agent silently terminates."""
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                invalid_tool_calls=[
                    {
                        "name": "PatchClaimProbeOutput",
                        "args": arguments,
                        "id": "invalid-output",
                        "error": None,
                    }
                ],
            ),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "fixed"},
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=tools,
        response_format=PatchClaimProbeOutput,
        middleware=[MissingStructuredResponseMiddleware()],
    )
    result = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})
    assert result["structured_response"].rationale == "fixed"
    assert len(model.message_batches) == 2
    assert isinstance(model.message_batches[1][-1], HumanMessage)
    feedback = str(model.message_batches[1][-1].content)
    assert expected in feedback
    assert len(feedback) < 2000
    if expected == "Invalid":
        assert '"line": 1' in feedback
        assert '"column":' in feedback
        assert '"offset":' in feedback
        assert '"context":' in feedback
    assert any(
        isinstance(message, AIMessage) and message.invalid_tool_calls
        for message in model.message_batches[1]
    )


@pytest.mark.parametrize("max_retries", [0, 1, 2])
def test_invalid_tool_arguments_recovery_is_bounded(max_retries: int) -> None:
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                invalid_tool_calls=[
                    {
                        "name": "PatchClaimProbeOutput",
                        "args": "{",
                        "id": f"invalid-output-{index}",
                        "error": "Invalid JSON",
                    }
                ],
            )
            for index in range(max_retries + 1)
        ]
    )
    agent = create_agent(
        model=model,
        tools=[],
        response_format=PatchClaimProbeOutput,
        middleware=[MissingStructuredResponseMiddleware(max_retries=max_retries)],
    )
    with pytest.raises(RuntimeError, match=f"Retried {max_retries} time"):
        agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})
    assert len(model.message_batches) == max_retries + 1


def test_invalid_arguments_do_not_skip_valid_tool_calls() -> None:
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "lookup_evidence",
                        "args": {"query": "session"},
                        "id": "valid-lookup",
                    }
                ],
                invalid_tool_calls=[
                    {
                        "name": "PatchClaimProbeOutput",
                        "args": "{",
                        "id": "invalid-output",
                        "error": "Invalid JSON",
                    }
                ],
            ),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "fixed"},
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[lookup_evidence],
        response_format=PatchClaimProbeOutput,
        middleware=[MissingStructuredResponseMiddleware()],
    )
    result = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})
    assert result["structured_response"].rationale == "fixed"
    assert len(model.message_batches) == 2
    tool_result = model.message_batches[1][-1]
    assert isinstance(tool_result, ToolMessage)
    assert tool_result.tool_call_id == "valid-lookup"
    assert tool_result.content == "evidence for session"


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True], ids=["invoke", "ainvoke"])
@pytest.mark.parametrize(
    "arguments",
    [
        None,
        "",
        '{"a": "unescaped "quote""}',
        '{"a": "truncated',
        '{"a": 1',
        '{\n  "正文": "bad ' + chr(92) + 'q"\n}',
        "!" + "x" * 10000,
        '{"a":"' + "😀" * 10000,
        "[]",
        '"text"',
        "42",
        "null",
        "[" * 2000,
        pytest.param(
            '{"a":' + "1" * (sys.get_int_max_str_digits() + 1) + "}",
            marks=pytest.mark.skipif(
                sys.get_int_max_str_digits() == 0,
                reason="Python integer conversion limit is disabled",
            ),
        ),
    ],
    ids=[
        "missing",
        "empty",
        "quote",
        "truncated-string",
        "missing-brace",
        "multiline-unicode",
        "error-at-start",
        "error-at-end",
        "array",
        "string",
        "number",
        "null",
        "deep-nesting",
        "integer-conversion-limit",
    ],
)
async def test_rejected_arguments_feedback_reaches_next_request(
    arguments: str | None, asynchronous: bool
) -> None:
    """Exercise the agent boundary; diagnostics must survive into the next request."""
    rejected = AIMessage(
        content="",
        invalid_tool_calls=[
            {"name": "PatchClaimProbeOutput", "args": arguments, "id": "bad"}
        ],
    )
    original_calls = [dict(call) for call in rejected.invalid_tool_calls]
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            rejected,
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "recovered"},
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[],
        response_format=PatchClaimProbeOutput,
        middleware=[MissingStructuredResponseMiddleware()],
    )
    result = (
        await agent.ainvoke({"messages": [HumanMessage("Return the result.")]})
        if asynchronous
        else agent.invoke({"messages": [HumanMessage("Return the result.")]})
    )
    assert result["structured_response"].rationale == "recovered"
    assert len(model.message_batches) == 2
    correction = model.message_batches[1][-1]
    assert isinstance(correction, HumanMessage)
    assert isinstance(correction.content, str)
    assert len(correction.content) < 2500
    diagnostics = [
        json.loads(line)
        for line in correction.content.splitlines()
        if line.startswith("{")
    ]
    assert len(diagnostics) == 1
    detail = diagnostics[0]
    assert detail["tool"] == "PatchClaimProbeOutput"
    assert detail["error"]
    if isinstance(arguments, str):
        try:
            json.loads(arguments)
        except json.JSONDecodeError as error:
            assert (detail["line"], detail["column"], detail["offset"]) == (
                error.lineno,
                error.colno,
                error.pos,
            )
            start = detail["context_start"]
            assert (
                detail["context"] == arguments[start : start + len(detail["context"])]
            )
            assert len(detail["context"]) <= 160
            assert start <= error.pos <= start + len(detail["context"])
        except RecursionError:
            assert "deep" in detail["error"]
        except ValueError as error:
            assert str(error)[:300] in detail["error"]
            assert "context" not in detail
        else:
            assert "JSON object" in detail["error"]
    else:
        assert "retained" in detail["error"]
    history = next(
        message
        for message in model.message_batches[1]
        if isinstance(message, AIMessage) and message.invalid_tool_calls
    )
    assert history.invalid_tool_calls == original_calls
    assert rejected.invalid_tool_calls == original_calls


@pytest.mark.parametrize("call_count", [1, 3, 4, 30])
def test_many_invalid_calls_have_bounded_feedback(call_count: int) -> None:
    """Large payloads and call counts must not be echoed wholesale into recovery."""
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                invalid_tool_calls=[
                    {
                        "name": f"tool-{index}-" + "n" * 1000,
                        "args": '{"a":"' + "😀" * 10000,
                        "id": f"bad-{index}",
                    }
                    for index in range(call_count)
                ],
            ),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "recovered"},
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[],
        response_format=PatchClaimProbeOutput,
        middleware=[MissingStructuredResponseMiddleware()],
    )
    agent.invoke({"messages": [HumanMessage("Return the result.")]})
    feedback = str(model.message_batches[1][-1].content)
    diagnostics = [
        json.loads(line) for line in feedback.splitlines() if line.startswith("{")
    ]
    assert len(diagnostics) == min(3, call_count)
    assert [item["tool"] for item in diagnostics] == [
        (f"tool-{index}-" + "n" * 1000)[:100] for index in range(min(3, call_count))
    ]
    if call_count > 3:
        assert f"{call_count - 3} further invalid calls omitted." in feedback
    assert len(feedback) < 7000


def test_seeded_damaged_arguments_recover_without_mutation() -> None:
    """Every generated payload is invalid by construction, giving a stable oracle."""
    rng = random.Random(731)
    for index in range(40):
        text = "".join(rng.choices('abc😀\n"' + chr(92), k=rng.randrange(1, 300)))
        valid = json.dumps({"evidence": text}, ensure_ascii=False)
        # Truncate inside an object, or append an illegal trailing character.
        damaged = valid[: rng.randrange(1, len(valid))] if index % 2 else valid + "!"
        with pytest.raises(json.JSONDecodeError):
            json.loads(damaged)
        model = RecordingToolCallingFakeMessagesListChatModel(
            responses=[
                AIMessage(
                    content="",
                    invalid_tool_calls=[
                        {"name": "PatchClaimProbeOutput", "args": damaged, "id": "bad"}
                    ],
                ),
                structured_tool_call_message(
                    PatchClaimProbeOutput,
                    {"status": "applied", "changed_files": [], "rationale": "fixed"},
                ),
            ]
        )
        agent = create_agent(
            model=model,
            tools=[],
            response_format=PatchClaimProbeOutput,
            middleware=[MissingStructuredResponseMiddleware(max_retries=1)],
        )
        result = agent.invoke({"messages": [HumanMessage("Return the result.")]})
        assert result["structured_response"].rationale == "fixed"
        assert len(model.message_batches) == 2
        assert len(str(model.message_batches[1][-1].content)) < 2500
        history = next(
            m
            for m in model.message_batches[1]
            if isinstance(m, AIMessage) and m.invalid_tool_calls
        )
        assert history.invalid_tool_calls[0]["args"] == damaged


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True], ids=["invoke", "ainvoke"])
async def test_mixed_missing_outputs_share_retry_budget(asynchronous: bool) -> None:
    """Prose and malformed arguments cannot each reset the recovery budget."""
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                invalid_tool_calls=[
                    {"name": "PatchClaimProbeOutput", "args": "{", "id": "bad"}
                ],
            ),
            AIMessage(content="A prose-only response."),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "fixed"},
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[],
        response_format=PatchClaimProbeOutput,
        middleware=[MissingStructuredResponseMiddleware(max_retries=1)],
    )
    with pytest.raises(RuntimeError, match="Retried 1 time"):
        if asynchronous:
            await agent.ainvoke({"messages": [HumanMessage("Return the result.")]})
        else:
            agent.invoke({"messages": [HumanMessage("Return the result.")]})
    assert len(model.message_batches) == 2
