import ast
import json
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from deepagents.backends import CompositeBackend
from langchain.agents.middleware.types import ModelRequest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from sec_review_agents.agents.analysis.agent import run_analysis_agent
from sec_review_agents.agents.memory_extractor.prompts import build_extractor_prompt
from sec_review_agents.agents.memory_extractor.tools import (
    build_trajectory_tools,
)
from sec_review_agents.agents.memory_maintainer.prompts import build_maintenance_prompt
from sec_review_agents.agents.memory_maintainer.tools import (
    build_memory_delete_file_tool,
)
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.features import AGENT_MEMORY_CONSUMPTION_ENABLED_ENV
from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_path_views,
)
from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend
from sec_review_agents.filesystem.path_views import (
    memory_view,
    writable_memory_view,
)
from sec_review_agents.memory import extractor as memory_extraction
from sec_review_agents.memory import maintainer as memory_maintenance
from sec_review_agents.memory.runtime_view import materialized_memory_view
from sec_review_agents.runtime.memory_middleware import (
    DEFAULT_MEMORY_SYSTEM_PROMPT,
    MEMORY_INDEX_MAX_CHARS,
    MEMORY_INDEX_MAX_LINES,
    SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT,
    MemoryMiddleware,
)
from tests.project_paths import AGENTS_ROOT


@pytest.fixture(autouse=True)
def _stub_memory_agent_model(monkeypatch) -> None:
    monkeypatch.setattr(
        memory_extraction,
        "create_chat_model",
        Mock(return_value=Mock(name="memory-extractor-model")),
    )
    monkeypatch.setattr(
        memory_maintenance,
        "create_chat_model",
        Mock(return_value=Mock(name="memory-maintainer-model")),
    )


def _create_memory_tree(root: Path) -> Path:
    (root / "topics").mkdir(parents=True)
    (root / "MEMORY.md").write_text("# Security Review Experience Memory\n")
    return root


def _trajectory_jsonl(*contents: str) -> str:
    return "".join(
        json.dumps(
            {
                "seq": index,
                "event": "message",
                "message": {
                    "role": "assistant",
                    "id": f"message-{index}",
                    "name": None,
                    "content": content,
                    "additional_kwargs": {},
                    "response_metadata": {},
                    "tool_calls": [],
                    "invalid_tool_calls": [],
                    "tool_call_chunks": [],
                    "usage_metadata": None,
                },
            },
            separators=(",", ":"),
        )
        + "\n"
        for index, content in enumerate(contents, start=1)
    )


def test_stage_trajectories_copies_ordered_jsonl_files(tmp_path: Path) -> None:
    source = tmp_path / "run" / "trajectory.jsonl"
    source.parent.mkdir()
    trajectory_content = _trajectory_jsonl("message")
    source.write_text(trajectory_content, encoding="utf-8")
    destination = tmp_path / "staged"

    staged = memory_extraction.stage_trajectories(
        [
            ("trajectory", "trajectory", source),
        ],
        destination,
    )

    assert staged == [
        (
            "trajectory",
            Path("/trajectories/0001-trajectory.jsonl"),
        )
    ]
    assert (destination / "0001-trajectory.jsonl").read_text(
        encoding="utf-8"
    ) == trajectory_content
    assert not (destination / "MANIFEST.md").exists()


@pytest.mark.parametrize(
    "content",
    [
        _trajectory_jsonl("readable") + '{"seq":2,"event":"message","message":',
        '{"seq":2,"event":"message","message":{}}\n',
        "\n",
    ],
)
def test_stage_trajectories_preserves_incomplete_input(
    tmp_path: Path, content: str
) -> None:
    source = tmp_path / "trajectory.jsonl"
    source.write_text(content, encoding="utf-8")

    destination = tmp_path / "staged"
    memory_extraction.stage_trajectories(
        [("analyzer", "initial", source)],
        destination,
    )

    assert (destination / "0001-analyzer-initial.jsonl").read_text(
        encoding="utf-8"
    ) == content


def test_trajectory_tools_list_and_read_messages(tmp_path: Path) -> None:
    trajectory = tmp_path / "0001-analyzer-initial.jsonl"
    trajectory.write_text(
        _trajectory_jsonl("initial claim", "verified conclusion"),
        encoding="utf-8",
    )
    list_messages, read_message = build_trajectory_tools(tmp_path)

    listed = list_messages.invoke(
        {"file_path": "/trajectories/0001-analyzer-initial.jsonl"}
    )
    message = read_message.invoke(
        {
            "file_path": "/trajectories/0001-analyzer-initial.jsonl",
            "seq": 2,
        }
    )

    assert listed["ok"] is True
    assert [item["seq"] for item in listed["messages"]] == [1, 2]
    assert listed["messages"][1]["preview"] == "verified conclusion"
    assert message["value"] == "verified conclusion"


def test_list_trajectory_messages_rejects_partial_jsonl(
    tmp_path: Path,
) -> None:
    trajectory = tmp_path / "0001-analyzer-initial.jsonl"
    trajectory.write_text(
        _trajectory_jsonl("readable") + '{"seq":2,"event":"message"',
        encoding="utf-8",
    )
    list_messages, _ = build_trajectory_tools(tmp_path)

    result = list_messages.invoke(
        {"file_path": "/trajectories/0001-analyzer-initial.jsonl"}
    )

    assert result["ok"] is False
    assert "transcript JSONL" in result["error"]


def test_collect_review_memory_trajectories_uses_flat_published_files(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    published = review_root / "trajectories" / "0001-analyzer-initial.jsonl"
    unrelated = review_root / "notes" / "scratch.json"
    published.parent.mkdir(parents=True)
    unrelated.parent.mkdir(parents=True)
    published.write_text(_trajectory_jsonl("message"), encoding="utf-8")
    unrelated.write_text(
        '[{"index":0,"type":"note","content":"scratch"}]\n', encoding="utf-8"
    )

    refs = memory_extraction.collect_review_memory_trajectories(review_root)

    assert refs == [
        (
            "analyzer",
            "initial",
            published.resolve(),
        )
    ]


def test_collect_review_memory_trajectories_rejects_invalid_published_name(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    trajectory = review_root / "trajectories" / "analyzer.jsonl"
    trajectory.parent.mkdir(parents=True)
    trajectory.write_text(_trajectory_jsonl("message"), encoding="utf-8")

    with pytest.raises(ValueError, match="<order>-<stage>-<attempt>"):
        memory_extraction.collect_review_memory_trajectories(review_root)


def test_collect_review_memory_trajectories_skips_non_memory_stage(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    trajectories = review_root / "trajectories"
    trajectories.mkdir(parents=True)
    analyzer = trajectories / "0001-analyzer-initial.jsonl"
    cvss = trajectories / "0002-cvss-initial.jsonl"
    analyzer.write_text(_trajectory_jsonl("analysis"), encoding="utf-8")
    cvss.write_text(_trajectory_jsonl("score"), encoding="utf-8")

    refs = memory_extraction.collect_review_memory_trajectories(review_root)

    assert [(stage, path) for stage, _attempt, path in refs] == [
        ("analyzer", analyzer.resolve())
    ]


def test_stage_review_trajectories_writes_ordered_prompt(tmp_path: Path) -> None:
    sources = []
    for label in ("analyzer", "mitigator", "verifier"):
        path = tmp_path / f"{label}.jsonl"
        path.write_text(_trajectory_jsonl("message"), encoding="utf-8")
        sources.append(path)

    staged = memory_extraction.stage_trajectories(
        [
            ("analyzer", "initial", sources[0]),
            ("mitigator", "initial", sources[1]),
            ("verifier", "initial", sources[2]),
        ],
        tmp_path / "staged",
    )

    assert staged == [
        (
            "analyzer initial",
            Path("/trajectories/0001-analyzer-initial.jsonl"),
        ),
        (
            "mitigator initial",
            Path("/trajectories/0002-mitigator-initial.jsonl"),
        ),
        (
            "verifier initial",
            Path("/trajectories/0003-verifier-initial.jsonl"),
        ),
    ]
    prompt = build_extractor_prompt(staged)
    assert "analyzer initial: `/trajectories/0001-analyzer-initial.jsonl`" in prompt
    assert "mitigator initial: `/trajectories/0002-mitigator-initial.jsonl`" in prompt
    assert "verifier initial: `/trajectories/0003-verifier-initial.jsonl`" in prompt
    assert str(tmp_path) not in prompt
    assert "source:" not in prompt
    assert "/trajectories/MANIFEST.md" not in prompt


def test_trajectory_extraction_prompt_extracts_observation_only() -> None:
    """Keep output-schema internals out of the extractor's task message."""
    user_prompt = build_extractor_prompt([])

    assert "has_observation" not in user_prompt
    assert "observation_markdown" not in user_prompt


def test_memory_maintenance_prompt_requires_an_observation() -> None:
    with pytest.raises(ValueError, match="requires at least one observation"):
        build_maintenance_prompt([])


def test_memory_delete_file_tool_deletes_direct_topic_file(tmp_path: Path) -> None:
    memory_root = _create_memory_tree(tmp_path / "memory")
    topic = memory_root / "topics" / "obsolete.md"
    topic.write_text("merged elsewhere\n", encoding="utf-8")

    tool = build_memory_delete_file_tool(memory_root)
    result = tool.invoke({"path": "/memory/topics/obsolete.md"})

    assert result == {
        "ok": True,
        "deleted": "/memory/topics/obsolete.md",
    }
    assert not topic.exists()


@pytest.mark.parametrize(
    "path",
    [
        "/memory/MEMORY.md",
        "/memory/topics",
        "/memory/topics/nested/obsolete.md",
        "/memory/topics/obsolete.txt",
        "/workspace/topics/obsolete.md",
        "/memory/topics/../MEMORY.md",
    ],
)
def test_memory_delete_file_tool_rejects_paths_outside_direct_topics(
    tmp_path: Path,
    path: str,
) -> None:
    memory_root = _create_memory_tree(tmp_path / "memory")
    index = memory_root / "MEMORY.md"
    index.write_text("index\n", encoding="utf-8")
    topic = memory_root / "topics" / "obsolete.md"
    topic.write_text("topic\n", encoding="utf-8")

    tool = build_memory_delete_file_tool(memory_root)
    result = tool.invoke({"path": path})

    assert result["ok"] is False
    assert (memory_root / "MEMORY.md").exists()
    assert topic.exists()


def test_memory_middleware_uses_generic_prompt_by_default() -> None:
    request = ModelRequest(
        model=FakeMessagesListChatModel(responses=[]),
        messages=[],
        system_prompt="Base prompt.",
    )

    middleware = MemoryMiddleware()
    modified = middleware.modify_request(request)

    assert middleware.system_prompt_template is DEFAULT_MEMORY_SYSTEM_PROMPT
    assert modified.system_prompt == f"Base prompt.\n\n{middleware.system_prompt()}"


def test_memory_middleware_accepts_complete_prompt_profile() -> None:
    middleware = MemoryMiddleware(
        system_prompt_template=SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT,
    )

    assert middleware.system_prompt_template is SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT


@pytest.mark.parametrize(
    "relative_path",
    [
        "src/sec_review_agents/agents/analysis/agent.py",
        "src/sec_review_agents/agents/mitigation/agent.py",
        "src/sec_review_agents/agents/single_agent/agent.py",
        "src/sec_review_agents/agents/verification/agent.py",
    ],
)
def test_security_review_agents_select_specialized_memory_prompt(
    relative_path: str,
) -> None:
    """Keep domain policy explicit where security-review agents are assembled."""
    module_path = AGENTS_ROOT / relative_path
    module = ast.parse(module_path.read_text(encoding="utf-8"))
    memory_calls = [
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "MemoryMiddleware"
    ]

    assert len(memory_calls) == 1
    prompt_keywords = [
        keyword.value
        for keyword in memory_calls[0].keywords
        if keyword.arg == "system_prompt_template"
    ]
    assert len(prompt_keywords) == 1
    assert isinstance(prompt_keywords[0], ast.Name)
    assert prompt_keywords[0].id == "SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT"


def test_memory_middleware_default_index_cap_matches_claude_code_style() -> None:
    assert MEMORY_INDEX_MAX_LINES == 200
    assert MEMORY_INDEX_MAX_CHARS == 25_000


def test_memory_middleware_injects_memory_index_from_backend(tmp_path: Path) -> None:
    memory_root = _create_memory_tree(tmp_path / "memory")
    (memory_root / "MEMORY.md").write_text(
        "\n".join(
            [
                "# Security Review Experience Memory",
                "",
                "- Verifier lessons: read `topics/verifier.md` when checking carried-forward evidence.",
                "- Evidence requirements: read `topics/evidence.md` when grounding is unclear.",
                "- Hidden line that should not be loaded.",
            ]
        ),
        encoding="utf-8",
    )
    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        backend = create_backend_with_path_views(
            container_name_prefix="memory-test",
            path_views=[memory_view(host_path=memory_root)],
        )
    request = ModelRequest(
        model=FakeMessagesListChatModel(responses=[]),
        messages=[],
        system_prompt="Base prompt.",
    )

    modified = MemoryMiddleware(
        backend=backend,
        index_max_lines=4,
    ).modify_request(request)

    assert modified.system_prompt is not None
    assert "### Memory Index" in modified.system_prompt
    assert "Verifier lessons" in modified.system_prompt
    assert "Evidence requirements" in modified.system_prompt
    assert "Hidden line" not in modified.system_prompt


def test_memory_middleware_handles_missing_memory_index() -> None:
    request = ModelRequest(
        model=FakeMessagesListChatModel(responses=[]),
        messages=[],
        system_prompt="Base prompt.",
    )

    modified = MemoryMiddleware().modify_request(request)

    assert modified.system_prompt is not None
    assert "Memory index is not available" in modified.system_prompt


def test_memory_view_is_read_only(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_root.mkdir()

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        backend = create_backend_with_path_views(
            container_name_prefix="memory-test",
            path_views=[memory_view(host_path=memory_root)],
        )

    assert isinstance(backend, CompositeBackend)
    route = backend.routes["/memory/"]
    assert isinstance(route, LocalFilesystemBackend)
    assert route.root_dir == memory_root
    assert not route.writable


def test_writable_memory_view_allows_memory_writes(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_root.mkdir()

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        backend = create_backend_with_path_views(
            container_name_prefix="memory-test",
            path_views=[writable_memory_view(host_path=memory_root)],
        )

    assert isinstance(backend, CompositeBackend)
    route = backend.routes["/memory/"]
    assert isinstance(route, LocalFilesystemBackend)
    assert route.root_dir == memory_root
    assert route.writable


def test_materialized_memory_view_is_scoped_to_one_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(AGENT_MEMORY_CONSUMPTION_ENABLED_ENV, "true")
    reference = ArtifactReference(
        uri=f"s3://sec-review/memory/trees/{'a' * 64}/memory-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )
    catalog_client = Mock(
        get_memory_tree=Mock(
            return_value={"revision": 3, "memory_tree_reference": reference.as_dict()}
        )
    )
    materialize_calls: list[tuple[ArtifactReference, Path]] = []

    def fake_materialize(
        value: ArtifactReference,
        *,
        destination: Path,
    ) -> Path:
        materialize_calls.append((value, destination))
        content_root = destination / "memory"
        (content_root / "topics").mkdir(parents=True)
        (content_root / "MEMORY.md").write_text("# Coordinated\n", encoding="utf-8")
        return content_root

    with (
        patch(
            "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
            return_value=catalog_client,
        ),
        patch(
            "sec_review_agents.memory.memory_tree_artifact.materialize_memory_tree",
            side_effect=fake_materialize,
        ),
        materialized_memory_view() as path_view,
    ):
        assert path_view is not None
        assert path_view.host_path is not None
        materialized_root = path_view.host_path.parent
        assert path_view.agent_path == "/memory"
        assert (path_view.host_path / "MEMORY.md").read_text(
            encoding="utf-8"
        ) == "# Coordinated\n"
        assert materialized_root.exists()

    assert not materialized_root.exists()
    assert len(materialize_calls) == 1
    assert materialize_calls[0][0] == reference
    assert materialize_calls[0][1].name == "memory-tree"


def test_materialized_memory_view_is_absent_without_catalog(
    monkeypatch,
) -> None:
    monkeypatch.setenv(AGENT_MEMORY_CONSUMPTION_ENABLED_ENV, "true")
    monkeypatch.delenv("AGENT_MEMORY_CATALOG_URL", raising=False)
    monkeypatch.delenv("AGENT_MEMORY_CATALOG_TOKEN", raising=False)

    with materialized_memory_view() as path_view:
        assert path_view is None


@pytest.mark.asyncio
async def test_analysis_agent_enables_memory_when_runtime_memory_exists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv(AGENT_MEMORY_CONSUMPTION_ENABLED_ENV, "true")
    captured_middleware = []

    async def fake_build_agent_runtime_graph(**kwargs):
        captured_middleware.extend(kwargs["middleware"])
        return object()

    with (
        patch(
            "sec_review_agents.agents.analysis.agent.create_chat_model",
            return_value=Mock(),
        ),
        patch(
            "sec_review_agents.agents.analysis.agent.agent_skills_enabled",
            return_value=False,
        ),
        patch(
            "sec_review_agents.agents.analysis.agent.model_turn_diagnostics_enabled",
            return_value=False,
        ),
        patch(
            "sec_review_agents.agents.analysis.agent.create_summarization_middleware",
            return_value=Mock(),
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.build_agent_runtime_graph",
            side_effect=fake_build_agent_runtime_graph,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.invoke_agent_runtime_graph",
            return_value=Mock(model_dump=Mock(return_value={})),
        ),
    ):
        await run_analysis_agent(
            agent_name="issue-analyzer",
            backend=LocalFilesystemBackend(tmp_path / "workspace"),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
            memory_enabled=True,
        )

    assert any(isinstance(item, MemoryMiddleware) for item in captured_middleware)


def test_extraction_id_slugs_job_id() -> None:
    assert (
        memory_extraction.extraction_id(
            [Path("/tmp/a.json")],
            job_id="Issue Review-run-1",
        )
        == "issue-review-run-1"
    )


def test_extraction_id_falls_back_to_trajectory_hash() -> None:
    obs_id = memory_extraction.extraction_id([Path("/tmp/a.json"), Path("/tmp/b.json")])

    assert obs_id.startswith("trajectories-")
    assert len(obs_id) == len("trajectories-") + 16


def test_extraction_id_distinguishes_extraction_jobs() -> None:
    # The workflow layer owns uniqueness: it builds one job_id per case, so the
    # The memory layer only slugs the opaque job_id into the extraction id.
    assert (
        memory_extraction.extraction_id(
            [Path("/tmp/case.json")],
            job_id="repository-review-run-1-case-a",
        )
        == "repository-review-run-1-case-a"
    )
    assert memory_extraction.extraction_id(
        [Path("/tmp/case.json")], job_id="repository-review-run-1-case-b"
    ) != memory_extraction.extraction_id(
        [Path("/tmp/case.json")], job_id="repository-review-run-1-case-a"
    )


@pytest.mark.asyncio
async def test_analysis_agent_leaves_memory_disabled_when_runtime_memory_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv(AGENT_MEMORY_CONSUMPTION_ENABLED_ENV, "true")
    captured_middleware = []

    async def fake_build_agent_runtime_graph(**kwargs):
        captured_middleware.extend(kwargs["middleware"])
        return object()

    with (
        patch(
            "sec_review_agents.agents.analysis.agent.create_chat_model",
            return_value=Mock(),
        ),
        patch(
            "sec_review_agents.agents.analysis.agent.agent_skills_enabled",
            return_value=False,
        ),
        patch(
            "sec_review_agents.agents.analysis.agent.model_turn_diagnostics_enabled",
            return_value=False,
        ),
        patch(
            "sec_review_agents.agents.analysis.agent.create_summarization_middleware",
            return_value=Mock(),
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.build_agent_runtime_graph",
            side_effect=fake_build_agent_runtime_graph,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.invoke_agent_runtime_graph",
            return_value=Mock(model_dump=Mock(return_value={})),
        ),
    ):
        await run_analysis_agent(
            agent_name="issue-analyzer",
            backend=LocalFilesystemBackend(tmp_path / "workspace"),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
            memory_enabled=False,
        )

    assert not any(isinstance(item, MemoryMiddleware) for item in captured_middleware)


def test_trajectory_tools_page_large_messages_and_reuse_private_snapshot(
    tmp_path, monkeypatch
):
    from sec_review_agents.agents.memory_extractor import tools

    (tmp_path / "large.jsonl").write_text(
        _trajectory_jsonl(*["x" * 40000 for _ in range(23)])
    )
    parse = Mock(wraps=tools.parse_trajectory_jsonl)
    monkeypatch.setattr(tools, "parse_trajectory_jsonl", parse)
    listing, reading = tools.build_trajectory_tools(tmp_path)
    first = listing.invoke({"file_path": "/trajectories/large.jsonl"})
    assert len(first["messages"]) == 20
    assert first["next_offset"] == 20
    second = listing.invoke(
        {"file_path": "/trajectories/large.jsonl", "offset": first["next_offset"]}
    )
    assert [item["seq"] for item in second["messages"]] == [21, 22, 23]
    assert second["next_offset"] is None
    chunks = []
    offset = 0
    while True:
        page = reading.invoke(
            {
                "file_path": "/trajectories/large.jsonl",
                "seq": 1,
                "offset": offset,
                "limit": 8000,
            }
        )
        assert len(page["value"]) <= 8000
        assert page["complete"] is False
        chunks.append(page["value"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert "".join(chunks) == "x" * 40000
    assert parse.call_count == 1
    with pytest.raises(ValueError):
        reading.invoke(
            {"file_path": "/trajectories/large.jsonl", "seq": 1, "limit": 24001}
        )


def test_trajectory_tools_reject_symlink_escape_and_raw_filesystem_has_no_trajectory(
    tmp_path, monkeypatch
):
    from sec_review_agents.agents.memory_extractor.backend import (
        create_memory_extractor_backend,
    )

    private = tmp_path / "private"
    private.mkdir()
    external = tmp_path / "outside.jsonl"
    external.write_text(_trajectory_jsonl("private evidence"))
    (private / "escape.jsonl").symlink_to(external)
    listing, _ = build_trajectory_tools(private)
    assert listing.invoke({"file_path": "/trajectories/escape.jsonl"})["ok"] is False
    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "false")
    backend = create_memory_extractor_backend()
    from typing import TypedDict

    from langgraph.graph import END, START, StateGraph

    class State(TypedDict):
        files: dict
        result: str | None

    graph = StateGraph(State)
    graph.add_node(
        "read",
        lambda state: {"result": backend.read("/trajectories/outside.jsonl").error},
    )
    graph.add_edge(START, "read")
    graph.add_edge("read", END)
    raw = graph.compile().invoke({"files": {}, "result": ""})["result"]
    assert raw is not None
    assert "private evidence" not in raw
    assert "Error" in raw or "not found" in raw.lower()


def test_memory_reading_view_excludes_accounting_but_retains_review_evidence(tmp_path):
    record = json.loads(_trajectory_jsonl("evidence"))
    record["message"].update(
        {
            "response_metadata": {"model_name": "provider-private"},
            "additional_kwargs": {
                "reasoning_content": "reason",
                "diff": "-old\n+new",
                "provider_private": "omit",
            },
            "tool_calls": [
                {"id": "call", "name": "inspect", "args": {"path": "/workspace/a"}}
            ],
        }
    )
    (tmp_path / "probe.jsonl").write_text(json.dumps(record) + "\n")
    _, reading = build_trajectory_tools(tmp_path)
    page = reading.invoke({"file_path": "/trajectories/probe.jsonl", "seq": 1})
    assert page["value"] == "evidence"
    assert "usage_metadata" not in page
    assert "response_metadata" not in page
    assert "provider_private" not in str(page)
    reasoning = reading.invoke(
        {"file_path": "/trajectories/probe.jsonl", "seq": 1, "part": "reasoning"}
    )
    assert reasoning["value"] == "reason"
    diff = reading.invoke(
        {"file_path": "/trajectories/probe.jsonl", "seq": 1, "part": "diff"}
    )
    assert diff["value"] == "-old\n+new"
    call = reading.invoke(
        {
            "file_path": "/trajectories/probe.jsonl",
            "seq": 1,
            "part": "tool_calls",
            "tool_call_id": "call",
        }
    )
    assert call["value"]["args"] == {"path": "/workspace/a"}


def test_memory_scratch_files_use_graph_state_without_writing_to_host(
    tmp_path, monkeypatch
):
    from typing import TypedDict

    from langgraph.graph import END, START, StateGraph

    from sec_review_agents.agents.memory_extractor.backend import (
        create_memory_extractor_backend,
    )

    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "false")
    backend = create_memory_extractor_backend()

    class State(TypedDict):
        files: dict
        result: str

    def write(state):
        result = backend.write("/tmp/notes.md", "temporary notes")
        assert result.error is None
        return {}

    def read(state):
        result = backend.read("/tmp/notes.md")
        assert result.error is None
        return {"result": str(result)}

    graph = StateGraph(State)
    graph.add_node("write", write)
    graph.add_node("read", read)
    graph.add_edge(START, "write")
    graph.add_edge("write", "read")
    graph.add_edge("read", END)
    result = graph.compile().invoke({"files": {}, "result": ""})
    assert "/tmp/notes.md" in result["files"]
    assert "temporary notes" in result["result"]


@pytest.mark.parametrize("status", ["failed", "completed", None])
def test_memory_index_exposes_execution_outcome_without_protocol_events(
    tmp_path, status
):
    message = json.loads(_trajectory_jsonl("evidence"))
    message["seq"] = 2
    events = [{"seq": 1, "event": "model_calls_start"}, message]
    if status is not None:
        events.append({"seq": 3, "event": "model_calls_end", "status": status})
    (tmp_path / "status.jsonl").write_text(
        "\n".join(json.dumps(event) for event in events) + "\n"
    )
    listing, _ = build_trajectory_tools(tmp_path)
    page = listing.invoke({"file_path": "/trajectories/status.jsonl"})
    assert page["execution_status"] == (status or "unknown")
    assert [message["seq"] for message in page["messages"]] == [2]


def test_semantic_tool_read_keeps_arguments_whole_and_pages_selected_text(tmp_path):
    record = json.loads(_trajectory_jsonl("Inspecting the file."))
    record["message"]["tool_calls"] = [
        {
            "id": "edit",
            "name": "write_file",
            "args": {"path": "/workspace/a", "content": "abc" * 15000},
        }
    ]
    (tmp_path / "semantic.jsonl").write_text(json.dumps(record) + "\n")
    _, read = build_trajectory_tools(tmp_path)
    request = {
        "file_path": "/trajectories/semantic.jsonl",
        "seq": 1,
        "part": "tool_calls",
        "tool_call_id": "edit",
    }
    oversized = read.invoke(request)
    assert oversized["ok"] is False
    assert "value" not in oversized
    path = read.invoke({**request, "argument": "path"})
    assert path["value"] == "/workspace/a"
    assert path["complete"] is True
    first = read.invoke({**request, "argument": "content", "limit": 1000})
    second = read.invoke(
        {
            **request,
            "argument": "content",
            "offset": first["next_offset"],
            "limit": 1000,
        }
    )
    assert first["value"] == ("abc" * 15000)[:1000]
    assert second["value"] == ("abc" * 15000)[1000:2000]
    assert first["complete"] is False
    assert read.invoke({**request, "tool_call_id": "missing"})["ok"] is False
    assert read.invoke({**request, "part": "content"})["ok"] is False
    assert (
        read.invoke(
            {
                "file_path": "/trajectories/semantic.jsonl",
                "seq": 1,
                "part": "tool_result",
            }
        )["ok"]
        is False
    )


def test_semantic_tool_result_read_preserves_failure_without_unrelated_fields(tmp_path):
    record = json.loads(_trajectory_jsonl("Missing required file_path."))
    record["message"].update(role="tool", tool_call_id="read", status="error")
    (tmp_path / "result.jsonl").write_text(json.dumps(record) + "\n")
    _, read = build_trajectory_tools(tmp_path)
    page = read.invoke(
        {"file_path": "/trajectories/result.jsonl", "seq": 1, "part": "tool_result"}
    )
    assert page["value"] == "Missing required file_path."
    assert page["tool_call_id"] == "read"
    assert page["status"] == "error"
    assert "usage_metadata" not in page


@pytest.mark.parametrize("block_format", ["standard", "summary", "thinking"])
@pytest.mark.parametrize(
    "reasoning", ["Check the caller after validation.", "推理 evidence. " * 3000]
)
def test_trajectory_reasoning_blocks_survive_persistence_and_pagination(
    tmp_path: Path, block_format: str, reasoning: str
) -> None:
    """Evidence stored by the writer must remain reachable through semantic reads."""
    from sec_review_agents.runtime.trajectories import TrajectoryWriter

    block: dict[str, object]
    if block_format == "standard":
        block = {"type": "reasoning", "reasoning": reasoning}
    elif block_format == "summary":
        block = {
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": reasoning}],
        }
    else:
        block = {"type": "thinking", "thinking": reasoning}
    path = tmp_path / "reasoning.jsonl"
    TrajectoryWriter((path,)).write_messages(
        [AIMessage(content=[block, {"type": "text", "text": "Visible answer."}])]
    )
    _, read = build_trajectory_tools(tmp_path)
    chunks = []
    offset = 0
    while True:
        page = read.invoke(
            {
                "file_path": "/trajectories/reasoning.jsonl",
                "seq": 1,
                "part": "reasoning",
                "offset": offset,
            }
        )
        assert page["ok"] is True
        assert page["total_chars"] == len(reasoning)
        assert page["value"] == reasoning[offset : offset + 12000]
        assert page["complete"] is (offset == 0 and len(reasoning) <= 12000)
        chunks.append(page["value"])
        if page["next_offset"] is None:
            break
        assert page["next_offset"] == offset + len(page["value"])
        offset = page["next_offset"]
    assert "".join(chunks) == reasoning
    body = read.invoke(
        {"file_path": "/trajectories/reasoning.jsonl", "seq": 1, "part": "content"}
    )
    assert body["value"] == "Visible answer."
