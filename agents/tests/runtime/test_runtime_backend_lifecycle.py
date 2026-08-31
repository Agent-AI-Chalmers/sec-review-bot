import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from deepagents.backends import CompositeBackend
from deepagents.backends.protocol import BackendProtocol
from langchain.agents.middleware import AgentMiddleware

from sec_review_agents.agents.analysis.pull_request import create_pr_analyzer_backend
from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
from sec_review_agents.agents.patch_synthesis.backend import (
    create_patch_synthesis_backend,
)
from sec_review_agents.filesystem.docker_backend import DockerRoute
from sec_review_agents.filesystem.docker_runtime import DockerContainerResource
from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import (
    close_backend_container,
    managed_backend,
)
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.runtime.summarization_middleware import (
    SEC_REVIEW_SUMMARY_PROMPT,
    create_summarization_middleware,
)


class _BackendStub(BackendProtocol):
    def __init__(self, *, container: DockerContainerResource | None = None) -> None:
        self.container = container
        self.close = Mock()


def _docker_container() -> DockerContainerResource:
    return DockerContainerResource(
        container_name="test-container",
        image="test-image:latest",
        shell="/bin/sh",
        start_command="while true; do sleep 3600; done",
        mounts=[],
        working_directory="/workspace",
        environment={},
        auto_remove=True,
        network_mode="none",
        user=None,
        timeout_ms=None,
    )


def test_managed_backend_closes_docker_container() -> None:
    docker_container = _docker_container()
    backend = _BackendStub(container=docker_container)

    with (
        patch.object(docker_container, "close") as close,
        managed_backend(backend) as managed,
    ):
        assert managed is backend

    close.assert_called_once_with()


def test_managed_backend_closes_docker_container_after_error() -> None:
    docker_container = _docker_container()
    backend = _BackendStub(container=docker_container)

    with (
        patch.object(docker_container, "close") as close,
        pytest.raises(RuntimeError, match="boom"),
        managed_backend(backend),
    ):
        raise RuntimeError("boom")

    close.assert_called_once_with()


def test_close_backend_container_ignores_non_docker_backends() -> None:
    backend = SimpleNamespace(close=Mock())

    close_backend_container(backend)

    backend.close.assert_not_called()


def test_filesystem_middleware_does_not_evict_stage_input_by_default() -> None:
    middleware = create_filesystem_middleware(backend=None)

    assert middleware._human_message_token_limit_before_evict is None


def test_filesystem_middleware_can_still_enable_human_message_eviction() -> None:
    middleware = create_filesystem_middleware(
        backend=None,
        human_message_token_limit_before_evict=50_000,
    )

    assert middleware._human_message_token_limit_before_evict == 50_000


@pytest.mark.asyncio
async def test_build_agent_runtime_graph_does_not_treat_backend_as_resource() -> None:
    backend = _BackendStub()
    model = Mock(name="model")

    with (
        patch("sec_review_agents.runtime.agent_runtime_graph.create_agent"),
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=backend,
            system_prompt="system",
        )

    backend.close.assert_not_called()


@pytest.mark.asyncio
async def test_build_agent_runtime_graph_records_backend_without_owning_container() -> (
    None
):
    docker_container = _docker_container()
    backend = _BackendStub(container=docker_container)
    model = Mock(name="model")

    with (
        patch.object(docker_container, "close") as close,
        patch("sec_review_agents.runtime.agent_runtime_graph.create_agent"),
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=backend,
            system_prompt="system",
        )

    close.assert_not_called()


@pytest.mark.asyncio
async def test_build_agent_runtime_graph_passes_model_middleware_and_tools_to_langchain() -> (
    None
):
    backend = _BackendStub()
    model = Mock(name="model")
    middleware = [AgentMiddleware()]
    tools = [Mock(name="tool")]

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent"
        ) as create_agent,
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=backend,
            system_prompt="system",
            tools=tools,
            middleware=middleware,
        )

    assert create_agent.call_args.kwargs["model"] is model
    assert create_agent.call_args.kwargs["middleware"] == middleware
    assert create_agent.call_args.kwargs["tools"] == tools


@pytest.mark.asyncio
async def test_build_agent_runtime_graph_loads_mcp_connections_as_tools() -> None:
    backend = _BackendStub()
    model = Mock(name="model")
    normal_tool = Mock(name="normal-tool")
    mcp_tool = Mock(name="mcp-tool")

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent"
        ) as create_agent,
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.load_mcp_tools_async",
            return_value=[mcp_tool],
        ) as load_mcp_tools_async,
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=backend,
            system_prompt="system",
            tools=[normal_tool],
            mcp_connections={"codegraph": {"transport": "stdio"}},
        )

    load_mcp_tools_async.assert_called_once_with({"codegraph": {"transport": "stdio"}})
    assert create_agent.call_args.kwargs["tools"] == [normal_tool, mcp_tool]


@pytest.mark.asyncio
async def test_build_agent_runtime_graph_loads_async_mcp_connections_as_tools() -> None:
    backend = _BackendStub()
    model = Mock(name="model")
    mcp_tool = Mock(name="mcp-tool")

    async def fake_load_mcp_tools_async(_connections):
        return [mcp_tool]

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent"
        ) as create_agent,
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.load_mcp_tools_async",
            side_effect=fake_load_mcp_tools_async,
        ) as load_mcp_tools_async,
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=backend,
            system_prompt="system",
            mcp_connections={"codegraph": {"transport": "stdio"}},
        )

    load_mcp_tools_async.assert_called_once_with({"codegraph": {"transport": "stdio"}})
    assert create_agent.call_args.kwargs["tools"] == [mcp_tool]


@pytest.mark.asyncio
async def test_build_agent_runtime_graph_passes_system_prompt() -> None:
    model = Mock(name="model")

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent"
        ) as create_agent,
        patch("sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=None,
            system_prompt="system",
        )

    assert create_agent.call_args.kwargs["system_prompt"] == "system"


@pytest.mark.asyncio
async def test_managed_backend_closes_docker_container_when_create_agent_fails() -> (
    None
):
    docker_container = _docker_container()
    backend = _BackendStub(container=docker_container)
    model = Mock(name="model")

    with (
        patch.object(docker_container, "close") as close,
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent",
            side_effect=RuntimeError("create failed"),
        ),
        pytest.raises(RuntimeError, match="create failed"),
        managed_backend(backend),
    ):
        await build_agent_runtime_graph(
            agent_name="test-agent",
            model=model,
            backend=backend,
            system_prompt="system",
        )

    close.assert_called_once_with()


def test_create_summarization_middleware_uses_absolute_token_limits() -> None:
    with (
        patch(
            "sec_review_agents.runtime.summarization_middleware.resolve_bound_deployment_max_input_tokens",
            return_value=1000,
        ),
        patch(
            "sec_review_agents.runtime.summarization_middleware.SummarizationMiddleware",
            return_value=Mock(),
        ) as middleware_cls,
    ):
        create_summarization_middleware(
            agent_name="issue-analyzer",
            model=Mock(),
        )

    middleware_cls.assert_called_once()
    assert middleware_cls.call_args.kwargs["trigger"] == ("tokens", 850)
    assert middleware_cls.call_args.kwargs["keep"] == ("tokens", 300)
    assert (
        middleware_cls.call_args.kwargs["summary_prompt"] == SEC_REVIEW_SUMMARY_PROMPT
    )
    assert middleware_cls.call_args.kwargs["trim_tokens_to_summarize"] is None
    assert "## Initial Stage Input" in SEC_REVIEW_SUMMARY_PROMPT
    assert "## Later User-Role Messages" in SEC_REVIEW_SUMMARY_PROMPT
    assert "## Source Boundaries" in SEC_REVIEW_SUMMARY_PROMPT
    assert "first user message" in SEC_REVIEW_SUMMARY_PROMPT


def test_repository_analyzer_backend_creates_docker_backend_without_pooling(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    (local_root / "workspace").mkdir(parents=True)

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="docker",
        ),
        patch(
            "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        ) as docker_backend_mock,
    ):
        backend = create_repository_analyzer_backend(
            workspace_root_path=local_root / "workspace",
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    assert backend is docker_backend_mock.return_value
    docker_backend_mock.assert_called_once()


def test_repository_analyzer_backend_uses_container_tmp_under_docker(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="docker",
        ),
        patch(
            "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        ) as docker_backend_mock,
    ):
        create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    container = docker_backend_mock.call_args.kwargs["container"]
    routes = docker_backend_mock.call_args.kwargs["routes"]
    assert not any(mount.container_path == "/tmp" for mount in container.mounts)
    assert (
        DockerRoute(
            container_path="/tmp",
            agent_path="/tmp",
            writable=True,
        )
        in routes
    )


def test_repository_analyzer_backend_uses_host_tmp_under_local(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)

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

    assert isinstance(backend, CompositeBackend)
    tmp_route = backend.routes["/tmp/"]
    assert isinstance(tmp_route, LocalFilesystemBackend)
    assert tmp_route.root_dir == Path(tempfile.gettempdir())
    assert tmp_route.writable


def test_repository_analyzer_backend_omits_skills_when_globally_disabled(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)

    with (
        patch.dict("os.environ", {"AGENT_SKILLS_ENABLED": "false"}),
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
    ):
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    assert "/skills/" not in backend.routes


def test_repository_analyzer_backend_omits_memory_when_globally_disabled(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    memory_root = local_root / "memory"
    workspace.mkdir(parents=True)
    (memory_root / "memory").mkdir(parents=True)
    (memory_root / "memory" / "MEMORY.md").write_text("# Memory\n", encoding="utf-8")

    with (
        patch.dict(
            "os.environ",
            {
                "AGENT_MEMORY_ENABLED": "false",
                "AGENT_MEMORY_DIR": str(memory_root),
            },
        ),
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
    ):
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    assert "/memory/" not in backend.routes


def test_runtime_workspace_image_reaches_pr_and_repository_docker_backends(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    incremental_window = local_root / "incremental-window"
    history = local_root / "history"
    workspace.mkdir(parents=True)
    incremental_window.mkdir(parents=True)
    history.mkdir(parents=True)
    image = "custom-workspace:latest"
    runtime_context: RunnerRuntimeContext = {
        "workspace_image": image,
    }

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="docker",
        ),
        patch(
            "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        ) as docker_backend_mock,
    ):
        create_pr_analyzer_backend(
            workspace_root_path=workspace,
            history_path=history,
            incremental_window_path=incremental_window,
            runtime_context=runtime_context,
        )
        create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
            runtime_context=runtime_context,
        )

    assert docker_backend_mock.call_count == 2
    assert all(
        call.kwargs["container"].image == image
        for call in docker_backend_mock.call_args_list
    )


def test_patch_synthesis_backend_stays_local_when_docker_is_enabled(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="docker",
        ),
        patch(
            "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        ) as docker_backend_mock,
    ):
        backend = create_patch_synthesis_backend(
            workspace_root_path=workspace,
            workspace_writable=True,
        )

    docker_backend_mock.assert_not_called()
    assert "/workspace/" in getattr(backend, "routes", {})
