from langchain_core.messages import AIMessage, ToolMessage

from tests.skills.probe_helpers import successful_read_paths


def test_read_evidence_requires_a_matching_successful_tool_response() -> None:
    """Neither a path claim nor a failed/unanswered read proves disclosure worked."""
    paths = ["/skills/cwe/SKILL.md", "/skills/missing.md", "/skills/unanswered.md"]
    result = {
        "messages": [
            AIMessage(content=f"I read {paths[0]}"),
            ToolMessage(content="unmatched response", tool_call_id="unknown"),
            AIMessage(
                content="",
                tool_calls=[
                    {"id": str(i), "name": "read_file", "args": {"file_path": path}}
                    for i, path in enumerate(paths)
                ],
            ),
            ToolMessage(content="# CWE Classification", tool_call_id="0"),
            ToolMessage(content="Error: not found", tool_call_id="1", status="error"),
        ],
        "structured_response": {"skill_path_read": paths[2]},
    }
    assert successful_read_paths(result) == {paths[0]}
