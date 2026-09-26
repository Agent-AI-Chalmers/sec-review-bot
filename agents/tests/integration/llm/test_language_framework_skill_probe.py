# Real-LLM probe for the bundled language-framework-security skill.
#
# This is intentionally lighter than the CVE contrast test. It does not measure
# analyzer quality or natural trigger rate. It checks the narrower progressive
# disclosure contract: the model can read the mounted skill, route to the Django
# reference, and apply one concrete framework rule.

import re
from collections.abc import Sequence
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


class LanguageFrameworkSkillProbeOutput(BaseModel):
    verdict: Literal["confirmed", "not-confirmed"] = Field()
    skill_path_read: str = Field()
    reference_path_read: str = Field()
    rule_applied: str = Field()
    rationale: str


_PROBE_RECURSION_LIMIT = 32


async def _create_language_framework_skill_probe_agent(*, workspace: Path):
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
        "You may read repository files and files under /skills. Use read_file "
        "when you need the full local skill instructions."
    )
    model = create_chat_model(
        agent_name="language-framework-skill-probe",
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
            agent_name="language-framework-skill-probe",
            model=model,
        ),
        PatchToolCallsMiddleware(),
    ]
    system_prompt = (
        "You are validating whether the language/framework security skill is "
        "usable. Before answering, read "
        "/skills/language-framework-security/SKILL.md and the single reference "
        "it routes you to for the repository code. Return structured output only."
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="language-framework-skill-probe",
        backend=backend,
        system_prompt=system_prompt,
        response_format=LanguageFrameworkSkillProbeOutput,
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
    run_env="RUN_LLM_LANGUAGE_FRAMEWORK_SKILL_PROBE",
    description="real LLM language/framework skill probe",
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_django_reference_distinguishes_orm_values_from_dynamic_sql(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    (workspace / "app").mkdir(parents=True)
    (workspace / "app" / "views.py").write_text(
        "\n".join(
            [
                "from django.db import connection",
                "from django.http import JsonResponse",
                "from .models import Customer",
                "",
                "def search(request):",
                "    name = request.GET['name']",
                "    order_by = request.GET['order_by']",
                "    rows = Customer.objects.filter(name=name)",
                "    with connection.cursor() as cursor:",
                "        cursor.execute(",
                '            f"SELECT id, name FROM app_customer ORDER BY {order_by}"',
                "        )",
                "    return JsonResponse({'count': rows.count()})",
                "",
            ]
        ),
        encoding="utf-8",
    )

    backend, agent = await _create_language_framework_skill_probe_agent(
        workspace=workspace,
    )
    async with amanaged_backend(backend):
        result = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "Read the language/framework skill and the Django "
                            "reference it routes you to. Assess this lead: "
                            "`Customer.objects.filter(name=name)` and a raw "
                            "`ORDER BY {order_by}` both use request data in "
                            "`app/views.py`. Is the Django ORM filter itself "
                            "the confirmed SQL injection? Set skill_path_read "
                            "and reference_path_read to the exact paths you used."
                        ),
                    }
                ]
            },
            config={"recursion_limit": _PROBE_RECURSION_LIMIT},
        )

    parsed = _parse_structured_response(
        result,
        LanguageFrameworkSkillProbeOutput,
    )
    print(parsed.model_dump(by_alias=True))
    assert parsed.verdict == "not-confirmed"
    assert parsed.skill_path_read == "/skills/language-framework-security/SKILL.md"
    assert (
        parsed.reference_path_read
        == "/skills/language-framework-security/references/python-django.md"
    )
    assert re.search(
        r"orm|parameter|raw sql|dynamic|column|order",
        f"{parsed.rule_applied} {parsed.rationale}".lower(),
    )
