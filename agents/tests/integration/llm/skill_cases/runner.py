import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import patch

from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware

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
from tests.integration.llm.skill_cases.models import (
    SkillCase,
    SkillCaseMode,
    SkillCaseOutput,
)
from tests.integration.llm.skill_probe_helpers import (
    record_skill_probe_result,
    successful_read_paths,
)

_RECURSION_LIMIT = 64


@dataclass(frozen=True)
class SkillCaseRun:
    output: SkillCaseOutput
    successful_reads: frozenset[str]


def materialize_case_workspace(case: SkillCase, destination: Path) -> Path:
    workspace = destination / "workspace"
    if case.workspace_source.is_dir():
        shutil.copytree(case.workspace_source, workspace)
    else:
        workspace.mkdir(parents=True)
    return workspace


def build_case_prompt(case: SkillCase, mode: SkillCaseMode) -> str:
    facts = "\n".join(f"- {fact}" for fact in case.facts)
    instruction = ""
    if mode == "prompted":
        instruction = (
            f"First read {case.skill_path} and {case.reference_path}. "
            "Set skill_path_read and reference_path_read to the exact paths used. "
        )
    workspace_instruction = (
        "Inspect the files under /workspace without executing them. "
        if case.workspace_source.is_dir()
        else ""
    )
    return (
        f"{instruction}{workspace_instruction}Task: {case.task}\n"
        f"Runtime facts:\n{facts}\n"
        "Return the verdict, evidence, rationale, material proof gaps, and any "
        "other structured fields that apply."
    )


async def _create_case_agent(*, workspace: Path, skills_enabled: bool, prompted: bool):
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
    model = create_chat_model(
        agent_name="skill-case-probe",
        deployment_override=deployment,
    )
    middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        )
    ]
    if skills_enabled:
        middleware.append(SkillsMiddleware(backend=backend, sources=["/skills/"]))
    middleware.extend(
        [
            create_filesystem_middleware(
                backend=backend,
                system_prompt=(
                    "You may read repository files and available skill files. "
                    "Use read_file when source or skill context is needed."
                ),
            ),
            create_summarization_middleware(
                agent_name="skill-case-probe",
                model=model,
                deployment_override=deployment,
            ),
            PatchToolCallsMiddleware(),
        ]
    )
    system_prompt = (
        "You are running a targeted bundled-skill application check. "
        + (
            "Read the explicitly named skill resources before deciding. "
            if prompted
            else "Select available resources only when they are relevant. "
        )
        + "Base the decision on repository evidence and return structured output only."
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="skill-case-probe",
        backend=backend,
        system_prompt=system_prompt,
        response_format=SkillCaseOutput,
        middleware=middleware,
    )
    return backend, agent


async def run_skill_case(
    case: SkillCase,
    *,
    mode: SkillCaseMode,
    skills_enabled: bool,
    temp_root: Path,
) -> SkillCaseRun:
    workspace = materialize_case_workspace(case, temp_root)
    backend, agent = await _create_case_agent(
        workspace=workspace,
        skills_enabled=skills_enabled,
        prompted=mode == "prompted",
    )
    async with amanaged_backend(backend):
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": build_case_prompt(case, mode)}]},
            config={"recursion_limit": _RECURSION_LIMIT},
        )
    label = f"skill-case-{case.id}-{mode}-{'with' if skills_enabled else 'without'}"
    record_skill_probe_result(
        result,
        label=label,
        metadata={
            "case_id": case.id,
            "mode": mode,
            "skills_enabled": skills_enabled,
        },
    )
    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = SkillCaseOutput.model_validate(parsed)
    if not isinstance(parsed, SkillCaseOutput):
        raise AssertionError(f"missing structured response for {case.id}: {result!r}")
    return SkillCaseRun(
        output=parsed,
        successful_reads=frozenset(successful_read_paths(result)),
    )


def assert_case_oracle(case: SkillCase, run: SkillCaseRun) -> None:
    expected = case.expected
    assert run.output.verdict == expected.verdict
    if expected.crosses_security_boundary is not None:
        assert (
            run.output.crosses_security_boundary is expected.crosses_security_boundary
        )
    if expected.attacker_controlled_argument is not None:
        assert (
            run.output.attacker_controlled_argument
            == expected.attacker_controlled_argument
        )
    if expected.require_proof_gaps:
        assert run.output.proof_gaps
    proof_gaps = " ".join(run.output.proof_gaps).lower()
    for requirement in expected.proof_gap_requirements:
        assert re.search(requirement, proof_gaps), (
            requirement,
            run.output.proof_gaps,
        )
    if expected.cwe_id is not None:
        assert run.output.cwe_id == expected.cwe_id
    if expected.parent_category_id is not None:
        assert run.output.parent_category_id == expected.parent_category_id
    explanation = " ".join(
        (
            run.output.precedent_applied,
            run.output.evidence,
            run.output.rationale,
        )
    ).lower()
    for requirement in expected.explanation_requirements:
        assert re.search(requirement, explanation), (requirement, explanation)
    if expected.explanation_pattern is not None:
        assert re.search(expected.explanation_pattern, explanation)


def assert_prompted_read(case: SkillCase, run: SkillCaseRun) -> None:
    assert run.output.skill_path_read == case.skill_path
    assert run.output.reference_path_read == case.reference_path
    assert case.skill_path in run.successful_reads
    assert case.reference_path in run.successful_reads


def assert_natural_read(case: SkillCase, run: SkillCaseRun) -> None:
    assert case.skill_path in run.successful_reads
    assert case.reference_path in run.successful_reads
