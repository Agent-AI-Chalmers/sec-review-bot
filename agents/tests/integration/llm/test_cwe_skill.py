# This real-LLM probe intentionally does not try to prove that CWE skills are
# always necessary. Strong models have internal CWE knowledge, which partially
# weakens the need for a local skill. The point here is narrower: use a colder
# weakness and require a navigation detail from the mounted local skill so the
# test can show the agent actually used the skill path, not merely a famous
# memorized label.

from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal
from unittest.mock import patch

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from pydantic import BaseModel, Field

from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)
from sec_review_agents.runtime.summarization_middleware import (
    create_summarization_middleware,
)
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import llm_probe


class CweSkillProbeOutput(BaseModel):
    cwe_id: Literal["CWE-698"] = Field()
    cwe_name: str = Field()
    parent_category_id: Literal["CWE-438"] = Field()
    parent_category_name: str = Field()
    skill_path_read: str = Field()
    navigation_path_read: str = Field()
    rationale: str


PROBE = llm_probe(
    run_env="RUN_LLM_CWE_SKILL_INTEGRATION",
    description="real LLM CWE skill probe",
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_llm_uses_cwe_skill_navigation_to_classify_execution_after_redirect(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"
    analyzer_artifacts = run_artifacts / "cases" / "case-1" / "analyzer"

    workspace.mkdir(parents=True, exist_ok=True)
    analyzer_artifacts.mkdir(parents=True, exist_ok=True)

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

    deployment = llm_test_deployment()
    filesystem_middleware_prompt = (
        "You may read files under /skills. Use read_file when you need "
        "the full skill instructions."
    )
    model = create_chat_model(
        agent_name="cwe-skill-probe",
        deployment_override=deployment,
    )
    middleware: Sequence[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        SkillsMiddleware(backend=backend, sources=["/skills/"]),
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_middleware_prompt,
        ),
        create_summarization_middleware(
            agent_name="cwe-skill-probe",
            model=model,
        ),
        PatchToolCallsMiddleware(),
    ]
    system_prompt = (
        "You are validating whether the CWE skill is usable. "
        "Before answering, read /skills/cwe/SKILL.md and the navigation "
        "file it tells you to read. Return structured output only."
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="cwe-skill-probe",
        backend=backend,
        system_prompt=system_prompt,
        response_format=CweSkillProbeOutput,
        middleware=middleware,
    )

    with managed_backend(backend):
        result = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "A supported security finding already exists: after "
                            "calling `response.redirect('/login')` for an "
                            "unauthorized request, the handler does not return or "
                            "stop execution. It continues into the privileged "
                            "account-update branch and can still apply the update "
                            "after the redirect response was issued. Use the CWE "
                            "skill and its navigation document to assign the best "
                            "second-level CWE. Set skill_path_read and "
                            "navigation_path_read to the exact paths you used."
                        ),
                    }
                ]
            },
            config={"recursion_limit": 20},
        )

    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = CweSkillProbeOutput.model_validate(parsed)

    assert isinstance(parsed, CweSkillProbeOutput)
    print(parsed.model_dump(by_alias=True))
    assert parsed.cwe_id == "CWE-698"
    assert "REDIRECT" in parsed.cwe_name.upper()
    assert parsed.parent_category_id == "CWE-438"
    assert "BEHAVIORAL" in parsed.parent_category_name.upper()
    assert parsed.skill_path_read == "/skills/cwe/SKILL.md"
    assert (
        parsed.navigation_path_read
        == "/skills/cwe/references/cwe-699-agent-navigation.md"
    )
