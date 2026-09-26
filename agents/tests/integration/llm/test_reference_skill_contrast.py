# Real-LLM contrast checks for natural judgments with and without SkillsMiddleware.
#
# Unlike the probe tests, these prompts do not instruct the model to read /skills.
# The skills-enabled run only receives the normal SkillsMiddleware exposure; the
# no-skills run receives the same repository and task without SkillsMiddleware.

import re
from pathlib import Path
from typing import Any, Literal
from unittest.mock import patch

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from pydantic import BaseModel, Field

from sec_review_agents.llm.factory import create_chat_model
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


class ReferenceSkillContrastOutput(BaseModel):
    verdict: Literal["confirmed", "not-confirmed"] = Field()
    vulnerability_type: str = Field()
    evidence: str
    rationale: str


_CONTRAST_RECURSION_LIMIT = 64


async def _create_natural_review_agent(
    *,
    workspace: Path,
    skills_enabled: bool,
):
    from sec_review_agents.agents.analysis.repository import (
        create_repository_analyzer_backend,
    )
    from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph

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
        "You may read repository files. Use read_file when you need source context."
    )
    model = create_chat_model(
        agent_name="reference-skill-contrast-probe",
        deployment_override=deployment,
    )
    middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
    ]
    if skills_enabled:
        middleware.append(SkillsMiddleware(backend=backend, sources=["/skills/"]))
    middleware.append(
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_middleware_prompt,
        )
    )
    middleware.append(
        create_summarization_middleware(
            agent_name="reference-skill-contrast-probe",
            model=model,
        )
    )
    middleware.append(PatchToolCallsMiddleware())
    system_prompt = (
        "You are running a targeted security review contrast check. Assess "
        "the lead using repository evidence. Return structured output only."
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="reference-skill-contrast-probe",
        backend=backend,
        system_prompt=system_prompt,
        response_format=ReferenceSkillContrastOutput,
        middleware=middleware,
    )
    return backend, agent


def _parse_structured_response[ParsedOutput: BaseModel](
    result: dict,
    model: type[ParsedOutput],
) -> ParsedOutput:
    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = model.model_validate(parsed)
    if not isinstance(parsed, model):
        raise AssertionError(f"missing structured response: {result!r}")
    return parsed


PROBE = llm_probe(
    run_env="RUN_LLM_REFERENCE_SKILL_CONTRAST",
    description="real LLM reference skill contrast checks",
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_command_argument_injection_with_and_without_skills(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    (workspace / "pkg").mkdir(parents=True)
    (workspace / "pkg" / "vcs.py").write_text(
        "\n".join(
            [
                "import subprocess",
                "",
                "def checkout(repo_type, checkout_ref, cwd):",
                "    subprocess.check_output(",
                "        [repo_type, 'checkout', checkout_ref],",
                "        cwd=cwd,",
                "    )",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / "pkg" / "cli.py").write_text(
        "\n".join(
            [
                "import argparse",
                "from .vcs import checkout",
                "",
                "def main():",
                "    parser = argparse.ArgumentParser()",
                "    parser.add_argument('--repo-type', default='hg')",
                "    parser.add_argument('--checkout', required=True)",
                "    parser.add_argument('--cwd', required=True)",
                "    args = parser.parse_args()",
                "    checkout(args.repo_type, args.checkout, args.cwd)",
                "",
            ]
        ),
        encoding="utf-8",
    )

    prompt = (
        "Assess this security lead: `pkg/cli.py` accepts `--checkout` "
        "from the command line and passes it to `pkg/vcs.py`, where "
        "`checkout_ref` is used as an argument-array element in "
        "`subprocess.check_output([repo_type, 'checkout', checkout_ref])`. "
        "For Mercurial, a value like "
        "`--config=hooks.pre-checkout=id` is parsed as an option and can "
        "execute a hook command. Is this a confirmed command/argument "
        "injection? Base your answer on repository evidence."
    )

    without_skills_backend, without_skills_agent = await _create_natural_review_agent(
        workspace=workspace,
        skills_enabled=False,
    )
    async with amanaged_backend(without_skills_backend):
        without_skills_result = await without_skills_agent.ainvoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={"recursion_limit": _CONTRAST_RECURSION_LIMIT},
        )

    with_skills_backend, with_skills_agent = await _create_natural_review_agent(
        workspace=workspace,
        skills_enabled=True,
    )
    async with amanaged_backend(with_skills_backend):
        with_skills_result = await with_skills_agent.ainvoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={"recursion_limit": _CONTRAST_RECURSION_LIMIT},
        )

    without_skills = _parse_structured_response(
        without_skills_result,
        ReferenceSkillContrastOutput,
    )
    with_skills = _parse_structured_response(
        with_skills_result,
        ReferenceSkillContrastOutput,
    )

    print(
        {
            "without_skills": without_skills.model_dump(by_alias=True),
            "with_skills": with_skills.model_dump(by_alias=True),
        }
    )
    assert with_skills.verdict == "confirmed"
    assert re.search(
        r"argument|array|--config|hook|flag|option|subprocess",
        f"{with_skills.evidence} {with_skills.rationale}".lower(),
    )
