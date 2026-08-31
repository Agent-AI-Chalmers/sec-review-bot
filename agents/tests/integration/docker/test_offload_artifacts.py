import re
from dataclasses import dataclass, replace
from types import SimpleNamespace
from typing import Any

import pytest
from deepagents import FilesystemMiddleware
from langchain_core.messages import HumanMessage, ToolMessage

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


@dataclass(frozen=True)
class _ModelRequest:
    messages: list[object]
    tools: list[object]
    model: object | None
    system_message: object | None
    state: dict
    runtime: object

    def override(self, **changes):
        return replace(self, **changes)


@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
def test_deepagents_human_message_offload_is_readable_in_docker() -> None:
    backend = create_backend_with_materials(
        container_name_prefix="offload-human-test",
        material_views=[],
        use_docker_sandbox=True,
    )
    assert isinstance(backend, DockerSandboxBackend)
    try:
        middleware = FilesystemMiddleware(
            backend=backend,
            human_message_token_limit_before_evict=1,
        )
        captured: dict[str, Any] = {}
        payload = "human-offload-marker\n" + ("x" * 100)
        request = _ModelRequest(
            messages=[HumanMessage(content=payload)],
            tools=[],
            model=None,
            system_message=None,
            state={},
            runtime=SimpleNamespace(),
        )

        middleware.wrap_model_call(
            request,  # type: ignore[arg-type]  # Minimal fake request for hook-level offload behavior.
            lambda updated_request: captured.setdefault(
                "messages",
                updated_request.messages,
            ),
        )

        content = captured["messages"][0].content
        path = _extract_path(
            content,
            r"filesystem at: (?P<path>/conversation_history/[^\s]+)",
        )
        read_result = backend.read(path)

        assert read_result.error is None
        assert read_result.file_data is not None
        assert read_result.file_data["content"] == payload
    finally:
        backend.container.close()


@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
def test_deepagents_tool_result_offload_is_readable_in_docker() -> None:
    backend = create_backend_with_materials(
        container_name_prefix="offload-tool-test",
        material_views=[],
        use_docker_sandbox=True,
    )
    assert isinstance(backend, DockerSandboxBackend)
    try:
        middleware = FilesystemMiddleware(
            backend=backend,
            tool_token_limit_before_evict=1,
        )
        payload = "tool-offload-marker\n" + ("y" * 100)
        request = SimpleNamespace(
            tool_call={"name": "execute"},
            runtime=SimpleNamespace(),
        )

        message = middleware.wrap_tool_call(
            request,  # type: ignore[arg-type]  # Minimal fake request for hook-level offload behavior.
            lambda _request: ToolMessage(
                content=payload,
                tool_call_id="offload-tool-call",
                name="execute",
            ),
        )

        assert isinstance(message, ToolMessage)
        path = _extract_path(
            message.content,
            r"filesystem at this path: (?P<path>/large_tool_results/[^\s]+)",
        )
        read_result = backend.read(path)

        assert read_result.error is None
        assert read_result.file_data is not None
        assert read_result.file_data["content"] == payload
    finally:
        backend.container.close()


def _extract_path(content: object, pattern: str) -> str:
    match = re.search(pattern, str(content))
    if match is None:
        raise AssertionError(f"offload path not found in content: {content!r}")
    return match.group("path")
