import json
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from tests.llm_probe import llm_probe, llm_test_deployment

pytestmark = [pytest.mark.integration, pytest.mark.llm]
PROBE = llm_probe(
    run_env="RUN_LLM_NEWLINE_EDITS",
    description="real LLM read/edit newline preservation probe",
)


@PROBE.skip_unless()
@pytest.mark.parametrize("style", ["crlf", "no-final-newline", "mixed"])
@pytest.mark.asyncio
async def test_llm_edits_with_upstream_newline_semantics(tmp_path: Path, style: str):
    """Exercise real filesystem middleware with upstream LF normalization.

    Each parameter is one agent run, potentially containing several model calls.
    No newline coaching is supplied: the agent must use read results/tool errors.
    """
    original = b"# settings\r\nretries = 1\r\ntimeout = 10\r\nenabled = False\r\n"
    if style == "no-final-newline":
        original = original.removesuffix(b"\r\n")
    elif style == "mixed":
        original = original.replace(b"timeout = 10\r\n", b"timeout = 10\n")
    path = tmp_path / "settings.py"
    path.write_bytes(original)
    expected = (
        original.replace(b"retries = 1", b"retries = 3")
        .replace(b"timeout = 10", b"timeout = 30")
        .replace(b"enabled = False", b"enabled = True")
    )
    backend = LocalFilesystemBackend(tmp_path)
    model = create_chat_model(
        agent_name="newline-edit-probe", deployment_override=llm_test_deployment()
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="newline-edit-probe",
        backend=backend,
        system_prompt="Edit the requested file using read_file and edit_file only. Read before editing. Make each requested setting change in a separate edit_file call. Preserve all unrelated content and formatting. If a tool reports an error, use its feedback to correct the request. Report completion briefly.",
        middleware=[create_filesystem_middleware(backend=backend)],
    )
    messages = []
    try:
        async for update in agent.astream(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": "Update /settings.py: set retries to 3, timeout to 30, and enabled to True.",
                    }
                ]
            },
            config={"recursion_limit": 20},
            stream_mode="updates",
        ):
            for node in update.values():
                if isinstance(node, dict):
                    messages.extend(node.get("messages", []))
    finally:
        # Persist even a failed trajectory so retries and failure causes remain inspectable.
        report = {
            "deployment": llm_test_deployment(),
            "style": style,
            "messages": [m.model_dump(mode="json") for m in messages],
            "expected_hex": expected.hex(),
            "actual_hex": path.read_bytes().hex(),
        }
        report_path = tmp_path / "probe.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"newline probe report: {report_path}")
    calls = [
        call
        for message in messages
        if isinstance(message, AIMessage)
        for call in message.tool_calls
    ]
    edits = [call for call in calls if call["name"] == "edit_file"]
    replies = [
        m for m in messages if isinstance(m, ToolMessage) and m.name == "edit_file"
    ]
    errors = [m for m in replies if m.status == "error" or "Error:" in str(m.content)]
    print(
        json.dumps(
            {"style": style, "edit_attempts": len(edits), "edit_errors": len(errors)}
        )
    )
    assert any(call["name"] == "read_file" for call in calls)
    assert all(call["name"] in {"read_file", "edit_file"} for call in calls)
    assert 3 <= len(edits) <= 6
    assert len(errors) <= 2
    assert path.read_bytes() == expected.replace(b"\r\n", b"\n")
