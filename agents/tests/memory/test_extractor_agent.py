import json
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from sec_review_agents.agents.memory_extractor.agent import run_memory_extractor_agent
from sec_review_agents.agents.memory_extractor.backend import (
    create_memory_extractor_backend,
)
from sec_review_agents.agents.memory_extractor.model import MemoryObservationOutput
from sec_review_agents.runtime.trajectories import read_trajectory_messages
from tests.runtime.fake_chat_models import (
    ToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("record_execution", [False, True])
@pytest.mark.parametrize("observations", [[], ["Lesson one.", "Lesson two."]])
async def test_extractor_reads_source_and_optionally_records_own_execution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    record_execution: bool,
    observations: list[str],
) -> None:
    """Exercise the real graph so input and output paths cannot silently swap roles."""
    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "false")
    source_root = tmp_path / "source"
    source_root.mkdir()
    source = source_root / "review.jsonl"
    evidence = (
        json.dumps(
            {
                "seq": 1,
                "event": "message",
                "message": {
                    "role": "assistant",
                    "id": "source-message",
                    "content": "Original review evidence.",
                },
            }
        )
        + "\n"
    )
    source.write_text(evidence)
    output = tmp_path / "extractor.jsonl"
    model = ToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "read-source",
                        "name": "read_trajectory_message",
                        "args": {"file_path": "/trajectories/review.jsonl", "seq": 1},
                    }
                ],
            ),
            structured_tool_call_message(
                MemoryObservationOutput,
                {"observations": observations},
            ),
        ]
    )
    result = await run_memory_extractor_agent(
        model=model,
        backend=create_memory_extractor_backend(),
        user_prompt="Inspect the review evidence.",
        source_trajectory_root=source_root,
        extractor_trajectory_path=output if record_execution else None,
    )

    assert result.observations == observations
    assert source.read_text() == evidence
    assert output.exists() is record_execution
    if record_execution:
        messages = read_trajectory_messages(output)
        response = next(m for m in messages if m.get("tool_call_id") == "read-source")
        assert json.loads(response["content"])["value"] == "Original review evidence."
