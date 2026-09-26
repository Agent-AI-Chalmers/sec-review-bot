from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents.middleware import AgentMiddleware
from pydantic import BaseModel, Field

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.material_views import (
    memory_view,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.middleware import MemoryMiddleware
from sec_review_agents.memory.store import initialize_memory_store, memory_content_dir
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


class MemoryMiddlewareProbeOutput(BaseModel):
    sentinel: str
    source_path: str = Field()
    rationale: str


MIDDLEWARE_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION",
    description="real LLM memory middleware probe",
)


@pytest.mark.skipif(
    not MIDDLEWARE_PROBE.enabled(),
    reason=MIDDLEWARE_PROBE.skip_reason(),
)
@pytest.mark.asyncio
async def test_llm_uses_memory_index_to_read_relevant_topic(tmp_path: Path) -> None:
    sentinel = "MEMORY_MIDDLEWARE_SENTINEL_7F3A91"
    memory_root = initialize_memory_store(tmp_path / "memory")
    runtime_memory_root = memory_content_dir(memory_root)
    topic_root = runtime_memory_root / "topics"
    (runtime_memory_root / "MEMORY.md").write_text(
        "\n".join(
            [
                "# Security Review Experience Memory",
                "",
                "## Topics",
                "",
                "- `topics/middleware-probe.md` - Probe lesson for the memory middleware sentinel.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (topic_root / "middleware-probe.md").write_text(
        "\n".join(
            [
                "# Middleware Probe",
                "",
                "When asked for the middleware probe sentinel, answer exactly:",
                "",
                f"`{sentinel}`",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    backend = create_backend_with_materials(
        container_name_prefix="memory-middleware-probe",
        material_views=[memory_view(host_path=runtime_memory_root)],
        use_docker_sandbox=False,
    )

    deployment = llm_test_deployment()
    filesystem_middleware_prompt = (
        "You may read files under /memory when the memory index says "
        "a relevant topic exists."
    )
    model = create_chat_model(
        agent_name="memory-middleware-probe",
        deployment_override=deployment,
    )
    middleware: Sequence[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        MemoryMiddleware(backend=backend),
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_middleware_prompt,
        ),
        create_summarization_middleware(
            agent_name="memory-middleware-probe",
            model=model,
        ),
        PatchToolCallsMiddleware(),
    ]
    system_prompt = (
        "You are testing whether reviewed experience memory is visible. "
        "Return structured output only."
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="memory-middleware-probe",
        backend=backend,
        system_prompt=system_prompt,
        response_format=MemoryMiddlewareProbeOutput,
        middleware=middleware,
    )

    async with amanaged_backend(backend):
        result = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "Use the available memory index to answer. "
                            "What is the middleware probe sentinel? Set "
                            "source_path to the topic file path that supplied it."
                        ),
                    }
                ]
            },
            config={"recursion_limit": 24},
        )

    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = MemoryMiddlewareProbeOutput.model_validate(parsed)

    assert isinstance(parsed, MemoryMiddlewareProbeOutput)
    print(parsed.model_dump(by_alias=True))
    assert parsed.sentinel == sentinel
    assert parsed.source_path == "/memory/topics/middleware-probe.md"
