# Real-LLM contrast checks for natural judgments with and without SkillsMiddleware.
#
# Unlike the probe tests, these prompts do not instruct the model to read /skills.
# The skills-enabled run only receives the normal SkillsMiddleware exposure; the
# no-skills run receives the same repository and task without SkillsMiddleware.

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
from tests.integration.llm.skill_probe_helpers import (
    record_skill_probe_result,
    successful_read_paths,
)


class ReferenceSkillContrastOutput(BaseModel):
    verdict: Literal["confirmed", "not-confirmed"] = Field()
    vulnerability_type: str = Field()
    attacker_controlled_argv: str | None = Field(
        description=(
            "One exact value supplied as the report name that changes the child "
            "parser's behavior, or null when no such single argv value exists."
        )
    )
    crosses_security_boundary: bool = Field()
    proof_gaps: list[str] = Field(default_factory=list)
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

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
        patch(
            "sec_review_agents.agents.analysis.repository.agent_skills_enabled",
            return_value=skills_enabled,
        ),
        patch(
            "sec_review_agents.agents.analysis.repository.agent_memory_enabled",
            return_value=False,
        ),
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
            deployment_override=deployment,
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
@pytest.mark.parametrize("service_consumer", [True, False], ids=["service", "own-cli"])
async def test_command_argument_boundary_with_and_without_skills(
    tmp_path: Path,
    service_consumer: bool,
) -> None:
    """The same parser input crosses authority only in the service consumer.

    The concrete argv value holds the mechanism constant so the paired oracle
    measures the threat boundary. The prompt still does not name a skill or
    require the baseline to fail or the model to load a skill.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "tool.py").write_text(
        "import argparse\n"
        "from pathlib import Path\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('name', nargs='?')\n"
        "parser.add_argument('--output', default='/srv/reports/result.txt')\n"
        "args = parser.parse_args()\n"
        "Path(args.output).write_text('generated report')\n",
        encoding="utf-8",
    )
    (workspace / "renderer.py").write_text(
        "import subprocess, sys\n"
        "from pathlib import Path\n"
        "def render(name):\n"
        "    tool = str(Path(__file__).with_name('tool.py'))\n"
        "    subprocess.run([sys.executable, tool, name], check=True)\n",
        encoding="utf-8",
    )
    if service_consumer:
        consumer = (
            "from renderer import render\n"
            "def post_report(request):\n"
            "    return render(request.json['name'])\n"
        )
        facts = (
            "post_report is exposed to untrusted remote users and runs as a "
            "service account. Users are allowed to request a report by name, "
            "not write arbitrary files. The service account can overwrite its "
            "configuration under /srv/config. No earlier input validation exists."
        )
    else:
        consumer = (
            "import sys\n"
            "from renderer import render\n"
            "if __name__ == '__main__': render(sys.argv[1])\n"
        )
        facts = (
            "This is only a CLI run by a local user with that user's own file "
            "permissions. The user supplies their own argument. There is no "
            "service, delegated privilege, remote input or other user involved. "
            "File output is an intended feature of the tool."
        )
    (workspace / "consumer.py").write_text(consumer, encoding="utf-8")
    prompt = (
        "Review /workspace/consumer.py, renderer.py and tool.py for a security "
        f"issue in the report-name path. Runtime facts: {facts} "
        "The report-name value under review is exactly "
        "'--output=/srv/config/runtime.json' and reaches renderer as one string. "
        "Inspect source only; do not execute these fixtures. Explain attacker "
        "capability, existing guards, impact and any missing preconditions."
    )

    outputs = {}
    observations = {}
    for enabled in (False, True):
        backend, agent = await _create_natural_review_agent(
            workspace=workspace,
            skills_enabled=enabled,
        )
        async with amanaged_backend(backend):
            result = await agent.ainvoke(
                {"messages": [{"role": "user", "content": prompt}]},
                config={"recursion_limit": _CONTRAST_RECURSION_LIMIT},
            )
        label = "with-skills" if enabled else "without-skills"
        record_skill_probe_result(result, label=f"argument-{service_consumer}-{label}")
        parsed = _parse_structured_response(result, ReferenceSkillContrastOutput)
        reads = successful_read_paths(result)
        outputs[enabled] = parsed
        observations[label] = {
            "output": parsed.model_dump(),
            "successful_reads": sorted(reads),
            "read_domain_reference": (
                "/skills/web-security/references/command-injection.md" in reads
            ),
            "correct": parsed.verdict
            == ("confirmed" if service_consumer else "not-confirmed"),
        }
        if not enabled:
            assert not any(path.startswith("/skills/") for path in reads)
    print(observations)
    assert outputs[True].verdict == (
        "confirmed" if service_consumer else "not-confirmed"
    )
    assert outputs[True].crosses_security_boundary is service_consumer
    attacker_controlled_argv = outputs[True].attacker_controlled_argv
    assert attacker_controlled_argv == "--output=/srv/config/runtime.json"
