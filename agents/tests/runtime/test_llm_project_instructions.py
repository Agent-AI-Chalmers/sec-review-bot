from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from pydantic import BaseModel, Field

from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import workspace_view
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.project_instructions_middleware import (
    ProjectInstructionsMiddleware,
)
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)
from tests.llm_probe import llm_probe, llm_test_deployment

pytestmark = [pytest.mark.integration, pytest.mark.llm]

PROBE = llm_probe(
    run_env="RUN_LLM_PROJECT_INSTRUCTIONS_INTEGRATION",
    description="real LLM project instructions probe",
)


class ProjectInstructionsProbeOutput(BaseModel):
    verdict: Literal["confirmed", "not-confirmed", "inconclusive"]
    affected_path: str = Field(description="Repository-relative source file reviewed.")
    suggested_test_command: str = Field(
        description="Focused test command prescribed by project guidance, not executed."
    )
    rationale: str


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_llm_uses_preloaded_project_validation_command(
    tmp_path: Path,
) -> None:
    """Project guidance supplies a validation command absent from the task and code.

    A fresh command marker proves use of this invocation's guidance. File tools
    remain available, including writes, so no-write observations are not simply
    the result of removing edit tools from the probe.
    """
    command = (
        "python -m pytest tests/test_redirects.py "
        f"-k redirect_policy_{uuid4().hex[:12]}"
    )
    guidance = "\n".join(
        [
            "# Project instructions",
            "",
            "## Focused validation",
            f"For redirect behavior, suggest this command: `{command}`.",
            "",
            "## Optional background",
            "docs/background.md describes unrelated subsystems.",
            "",
        ]
    )
    instructions = tmp_path / "AGENTS.md"
    instructions.write_text(guidance, encoding="utf-8")
    (tmp_path / "app.py").write_text(
        "def redirect_response(next_url: str):\n"
        '    return 302, {"Location": next_url}\n'
        "\n"
        "def handle_request(query: dict[str, str]):\n"
        '    return redirect_response(query.get("next", "/"))\n',
        encoding="utf-8",
    )
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "background.md").write_text(
        "# Unrelated subsystems\n\nNo redirect behavior is defined here.\n",
        encoding="utf-8",
    )
    backend = create_backend_with_path_views(
        container_name_prefix="project-instructions-probe",
        backend_kind="local",
        path_views=[workspace_view(host_path=tmp_path, writable=True)],
    )
    model = create_chat_model(
        agent_name="project-instructions-probe",
        deployment_override=llm_test_deployment(),
    )
    middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        ProjectInstructionsMiddleware(backend=backend),
        create_filesystem_middleware(backend=backend),
        PatchToolCallsMiddleware(),
    ]
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="project-instructions-probe",
        backend=backend,
        system_prompt=(
            "You are an independent security analyzer. Assess the supplied claim "
            "against current repository code. Do not edit the workspace or run "
            "commands in this static review. Return the configured structured output."
        ),
        response_format=ProjectInstructionsProbeOutput,
        middleware=middleware,
    )
    async with amanaged_backend(backend):
        result = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "Review /workspace/app.py for an open redirect. "
                            "handle_request receives attacker-controlled query "
                            "parameters; the HTTP adapter sends its returned status "
                            "and headers unchanged. Inspect the implementation and "
                            "give an independent verdict. Also suggest the focused "
                            "test command from project guidance; do not run it."
                        ),
                    }
                ]
            },
            config={"recursion_limit": 16},
        )

    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = ProjectInstructionsProbeOutput.model_validate(parsed)
    assert isinstance(parsed, ProjectInstructionsProbeOutput)
    calls = [
        call
        for message in result.get("messages", [])
        if isinstance(message, AIMessage)
        for call in message.tool_calls
    ]
    summary = {
        "deployment": llm_test_deployment(),
        "output": parsed.model_dump(),
        "tool_calls": [{"name": call["name"], "args": call["args"]} for call in calls],
    }
    print(summary)
    assert parsed.verdict == "confirmed"
    assert parsed.affected_path == "app.py"
    assert parsed.suggested_test_command == command
    reads = [
        call["args"].get("file_path") for call in calls if call["name"] == "read_file"
    ]
    assert "/workspace/app.py" in reads
    assert "/workspace/AGENTS.md" not in reads
    assert not any(
        call["name"] in {"write_file", "edit_file", "execute"} for call in calls
    )
    assert instructions.read_text(encoding="utf-8") == guidance
