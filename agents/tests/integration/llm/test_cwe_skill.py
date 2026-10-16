# This real-LLM probe intentionally does not try to prove that CWE skills are
# always necessary. Strong models have internal CWE knowledge, which partially
# weakens the need for a local skill. The point here is narrower: use a colder
# weakness and require a navigation detail from the mounted local skill so the
# test can show the agent actually used the skill path, not merely a famous
# memorized label.

from collections.abc import Sequence
from pathlib import Path
from typing import Any
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
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
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
from tests.integration.llm.skill_probe_helpers import (
    record_skill_probe_result,
    successful_read_paths,
)


class CweSkillProbeOutput(BaseModel):
    cwe_id: str = Field()
    cwe_name: str = Field()
    parent_category_id: str | None = None
    parent_category_name: str | None = None
    skill_path_read: str = Field()
    navigation_path_read: str = Field()
    rationale: str


PROBE = llm_probe(
    run_env="RUN_LLM_CWE_SKILL_INTEGRATION",
    description="real LLM CWE skill probe",
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("finding", "expected_cwe", "expected_parent"),
    [
        (
            (
                "After response.redirect('/login') for an unauthorized request, "
                "the handler does not return. It continues into a privileged "
                "account update and commits the change."
            ),
            "CWE-698",
            "CWE-438",
        ),
        (
            (
                "An attacker-controlled callback frees a heap object. The parser "
                "then dereferences that same object, causing an exploitable "
                "use-after-free. The ownership and attacker path are established."
            ),
            "CWE-416",
            None,
        ),
    ],
    ids=["redirect", "label-absent-from-local-index"],
)
async def test_llm_classifies_supported_findings_without_a_closed_label_set(
    tmp_path: Path,
    finding: str,
    expected_cwe: str,
    expected_parent: str | None,
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
            deployment_override=deployment,
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

    async with amanaged_backend(backend):
        result = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            f"A supported security finding already exists: {finding} "
                            "Use the CWE skill and its navigation document to "
                            "assign the best root-cause CWE. "
                            "Supply a navigation category only when applicable. "
                            "Set skill_path_read and navigation_path_read to the "
                            "exact paths you used."
                        ),
                    }
                ]
            },
            config={"recursion_limit": 20},
        )

    record_skill_probe_result(result, label="cwe-classification")
    reads = successful_read_paths(result)
    assert "/skills/cwe/SKILL.md" in reads
    assert "/skills/cwe/references/cwe-699-agent-navigation.md" in reads
    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = CweSkillProbeOutput.model_validate(parsed)

    assert isinstance(parsed, CweSkillProbeOutput)
    print(parsed.model_dump(by_alias=True))
    assert parsed.cwe_id == expected_cwe
    if expected_parent is not None:
        assert parsed.parent_category_id == expected_parent
    assert parsed.skill_path_read == "/skills/cwe/SKILL.md"
    assert (
        parsed.navigation_path_read
        == "/skills/cwe/references/cwe-699-agent-navigation.md"
    )
