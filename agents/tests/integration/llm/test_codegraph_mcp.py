# Real-LLM smoke for CodeGraph MCP wiring.
#
# This intentionally uses the local fallback path and does not enable filesystem
# tools. The model must use CodeGraph MCP tools to inspect the small workspace.

import shutil
from pathlib import Path
from typing import Any, Literal
from unittest.mock import patch

import pytest
from pydantic import BaseModel, Field

from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import ProbeRequirement, llm_probe


class CodeGraphMcpProbeOutput(BaseModel):
    symbol_name: Literal["build_admin_report"] = Field()
    file_path: str = Field()
    caller: str = Field()
    rationale: str


PROBE = llm_probe(
    run_env="RUN_LLM_CODEGRAPH_MCP_INTEGRATION",
    description="real LLM CodeGraph MCP probe",
    requirements=(
        ProbeRequirement(
            name="codegraph executable",
            is_met=lambda: shutil.which("codegraph") is not None,
            instruction="install codegraph on PATH",
        ),
    ),
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_llm_uses_codegraph_mcp_to_find_symbol_and_caller(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    (workspace / "service").mkdir(parents=True)
    (workspace / "service" / "reports.py").write_text(
        "\n".join(
            [
                "def build_admin_report(user):",
                "    return {'user': user.name, 'role': 'admin'}",
                "",
                "def render_dashboard(user):",
                "    report = build_admin_report(user)",
                "    return f\"Dashboard: {report['user']}\"",
                "",
            ]
        ),
        encoding="utf-8",
    )

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    with patch.dict(
        "os.environ",
        {"AGENT_MCP_ENABLED": "true"},
        clear=False,
    ):
        deployment = llm_test_deployment()
        model = create_chat_model(
            agent_name="codegraph-mcp-probe",
            deployment_override=deployment,
        )
        system_prompt = (
            "Use the available CodeGraph MCP tools to inspect the "
            "workspace. Do not guess from the prompt. Return structured "
            "output only."
        )
        agent = await build_agent_runtime_graph(
            model=model,
            agent_name="codegraph-mcp-probe",
            backend=backend,
            system_prompt=system_prompt,
            response_format=CodeGraphMcpProbeOutput,
            mcp_connections=codegraph_mcp_connections_for_backend(
                backend,
                host_workspace_path=workspace,
            ),
        )

    with managed_backend(backend):
        result = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "Find the symbol named build_admin_report. "
                            "Return its file path and one function that calls it."
                        ),
                    }
                ]
            },
            config={"recursion_limit": 25},
        )

    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = CodeGraphMcpProbeOutput.model_validate(parsed)

    assert isinstance(parsed, CodeGraphMcpProbeOutput)
    assert parsed.symbol_name == "build_admin_report"
    assert parsed.file_path.endswith("service/reports.py")
    assert parsed.caller == "render_dashboard"
    assert _used_codegraph_tool(result.get("messages", []))
    print(parsed.model_dump(by_alias=True))


def _used_codegraph_tool(messages: list[Any]) -> bool:
    for message in messages:
        for tool_call in getattr(message, "tool_calls", []) or []:
            name = (
                tool_call.get("name")
                if isinstance(tool_call, dict)
                else getattr(tool_call, "name", None)
            )
            if isinstance(name, str) and name.startswith("codegraph_"):
                return True

        name = getattr(message, "name", None)
        if isinstance(name, str) and name.startswith("codegraph_"):
            return True
    return False
