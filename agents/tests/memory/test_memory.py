import ast
import asyncio
import contextlib
import fcntl
import json
import os
import sqlite3
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from deepagents.backends import CompositeBackend
from langchain.agents.middleware.types import ModelRequest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel

from sec_review_agents.agents.analysis.agent import create_analysis_agent_graph
from sec_review_agents.agents.memory_extractor.backend import (
    create_memory_extractor_backend,
)
from sec_review_agents.agents.memory_extractor.model import StagedTranscripts
from sec_review_agents.agents.memory_extractor.prompts import build_extractor_prompt
from sec_review_agents.agents.memory_extractor.tools import (
    build_transcript_tools,
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
from sec_review_agents.memory import local_store as memory_store
from sec_review_agents.memory import maintainer as memory_maintenance
from sec_review_agents.memory.local_store import (
    AGENT_MEMORY_DIR_ENV,
    MEMORY_INDEX_MAX_CHARS,
    MEMORY_INDEX_MAX_LINES,
)
from sec_review_agents.memory.runtime_view import (
    AGENT_MEMORY_MATERIALIZED_ROOT_ENV,
    materialize_configured_memory_view,
    memory_runtime_available,
)
from sec_review_agents.memory.transcripts import memory_agent_transcript_path
from sec_review_agents.runtime.memory_middleware import (
    DEFAULT_MEMORY_SYSTEM_PROMPT,
    SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT,
    MemoryMiddleware,
)
from sec_review_agents.utils.env import load_dotenv_file
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


def _fetch_observations_by_extraction_ids(connection, extraction_ids: list[str]):
    if not extraction_ids:
        return []
    placeholders = ",".join("?" for _ in extraction_ids)
    rows = connection.execute(
        f"""
        select
          extraction_id,
          path,
          status,
          created_at,
          updated_at
        from observations
        where extraction_id in ({placeholders})
        order by created_at asc, extraction_id asc
        """,
        extraction_ids,
    ).fetchall()
    from sec_review_agents.memory.local_state import ObservationRow

    return [ObservationRow(*row) for row in rows]


def test_local_state_migrates_pre_extraction_identity_schema(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_root.mkdir()
    state_path = memory_root / "memory_state.sqlite"
    with sqlite3.connect(state_path) as connection:
        connection.execute("""create table observations (
                observation_id text primary key,
                path text not null,
                status text not null,
                created_at text not null,
                updated_at text not null
            )""")
        connection.execute(
            "insert into observations values (?, ?, ?, ?, ?)",
            ("legacy-id", "observations/legacy.md", "pending", "created", "updated"),
        )

    memory_store.initialize_memory_store(memory_root)

    with sqlite3.connect(state_path) as connection:
        row = connection.execute(
            "select extraction_id, path from observations where extraction_id = ?",
            ("legacy-id",),
        ).fetchone()
        schema_version = connection.execute("pragma user_version").fetchone()[0]

    assert tuple(row) == ("legacy-id", "observations/legacy.md")
    assert schema_version == 2


def test_local_state_rejects_unknown_observation_schema(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_root.mkdir()
    state_path = memory_root / "memory_state.sqlite"
    with sqlite3.connect(state_path) as connection:
        connection.execute("create table observations (unknown_id text primary key)")

    with pytest.raises(RuntimeError, match="unknown observations schema"):
        memory_store.initialize_memory_store(memory_root)


def test_local_state_rejects_newer_schema_version(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_root.mkdir()
    state_path = memory_root / "memory_state.sqlite"
    with sqlite3.connect(state_path) as connection:
        connection.execute("pragma user_version=3")

    with pytest.raises(RuntimeError, match="newer schema version: 3 > 2"):
        memory_store.initialize_memory_store(memory_root)


def _memory_content_dir(memory_store_dir: Path) -> Path:
    return memory_store.memory_content_dir(memory_store_dir)


def _memory_observations_dir(memory_store_dir: Path) -> Path:
    return memory_store.memory_observations_dir(memory_store_dir)


def _transcript_jsonl(*contents: str) -> str:
    return "".join(
        json.dumps(
            {
                "seq": index,
                "event": "message",
                "message": {
                    "type": "ai",
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


def test_stage_transcripts_copies_ordered_jsonl_files(tmp_path: Path) -> None:
    source = tmp_path / "run" / "transcript.jsonl"
    source.parent.mkdir()
    transcript_content = _transcript_jsonl("message")
    source.write_text(transcript_content, encoding="utf-8")
    destination = tmp_path / "staged"

    staged = memory_extraction.stage_transcripts(
        [
            memory_extraction.TranscriptRef(
                stage="transcript",
                attempt="transcript",
                path=source,
            )
        ],
        destination,
    )

    assert staged.entries == [
        (
            "transcript",
            Path("/transcripts/0001-transcript.jsonl"),
        )
    ]
    assert (destination / "0001-transcript.jsonl").read_text(
        encoding="utf-8"
    ) == transcript_content
    assert not (destination / "MANIFEST.md").exists()


@pytest.mark.parametrize(
    "content",
    [
        _transcript_jsonl("readable") + '{"seq":2,"event":"message","message":',
        '{"seq":2,"event":"message","message":{}}\n',
        "\n",
    ],
)
def test_stage_transcripts_preserves_incomplete_input(
    tmp_path: Path, content: str
) -> None:
    source = tmp_path / "transcript.jsonl"
    source.write_text(content, encoding="utf-8")

    destination = tmp_path / "staged"
    memory_extraction.stage_transcripts(
        [memory_extraction.TranscriptRef("analyzer", "initial", source)],
        destination,
    )

    assert (destination / "0001-analyzer-initial.jsonl").read_text(
        encoding="utf-8"
    ) == content


def test_transcript_tools_list_and_read_messages(tmp_path: Path) -> None:
    transcript = tmp_path / "0001-analyzer-initial.jsonl"
    transcript.write_text(
        _transcript_jsonl("initial claim", "verified conclusion"),
        encoding="utf-8",
    )
    backend = create_memory_extractor_backend(transcript_root=tmp_path)
    list_messages, read_message = build_transcript_tools(backend)

    listed = list_messages.invoke(
        {"file_path": "/transcripts/0001-analyzer-initial.jsonl"}
    )
    message = read_message.invoke(
        {
            "file_path": "/transcripts/0001-analyzer-initial.jsonl",
            "seq": 2,
        }
    )

    assert listed["ok"] is True
    assert [item["seq"] for item in listed["messages"]] == [1, 2]
    assert listed["messages"][1]["preview"] == "verified conclusion"
    assert message["message"]["content"] == "verified conclusion"


def test_list_transcript_messages_reports_partial_lines_without_losing_messages(
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "0001-analyzer-initial.jsonl"
    transcript.write_text(
        _transcript_jsonl("readable") + '{"seq":2,"event":"message"',
        encoding="utf-8",
    )
    backend = create_memory_extractor_backend(transcript_root=tmp_path)
    list_messages, _ = build_transcript_tools(backend)

    result = list_messages.invoke(
        {"file_path": "/transcripts/0001-analyzer-initial.jsonl"}
    )

    assert [message["seq"] for message in result["messages"]] == [1]
    assert result["parse_errors"][0]["line"] == 2


def test_collect_review_memory_transcripts_uses_flat_published_files(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    published = review_root / "transcripts" / "0001-analyzer-initial.jsonl"
    unrelated = review_root / "notes" / "scratch.json"
    published.parent.mkdir(parents=True)
    unrelated.parent.mkdir(parents=True)
    published.write_text(_transcript_jsonl("message"), encoding="utf-8")
    unrelated.write_text(
        '[{"index":0,"type":"note","content":"scratch"}]\n', encoding="utf-8"
    )

    refs = memory_extraction.collect_review_memory_transcripts(review_root)

    assert [(ref.stage, ref.attempt, ref.path) for ref in refs] == [
        (
            "analyzer",
            "initial",
            published.resolve(),
        )
    ]


def test_collect_review_memory_transcripts_rejects_invalid_published_name(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    transcript = review_root / "transcripts" / "analyzer.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(_transcript_jsonl("message"), encoding="utf-8")

    with pytest.raises(ValueError, match="<order>-<stage>-<attempt>"):
        memory_extraction.collect_review_memory_transcripts(review_root)


def test_collect_review_memory_transcripts_skips_non_memory_stage(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    transcripts = review_root / "transcripts"
    transcripts.mkdir(parents=True)
    analyzer = transcripts / "0001-analyzer-initial.jsonl"
    cvss = transcripts / "0002-cvss-initial.jsonl"
    analyzer.write_text(_transcript_jsonl("analysis"), encoding="utf-8")
    cvss.write_text(_transcript_jsonl("score"), encoding="utf-8")

    refs = memory_extraction.collect_review_memory_transcripts(review_root)

    assert [(ref.stage, ref.path) for ref in refs] == [("analyzer", analyzer.resolve())]


def test_stage_review_transcripts_writes_ordered_prompt(tmp_path: Path) -> None:
    sources = []
    for label in ("analyzer", "mitigator", "verifier"):
        path = tmp_path / f"{label}.jsonl"
        path.write_text(_transcript_jsonl("message"), encoding="utf-8")
        sources.append(path)

    staged = memory_extraction.stage_transcripts(
        [
            memory_extraction.TranscriptRef("analyzer", "initial", sources[0]),
            memory_extraction.TranscriptRef("mitigator", "initial", sources[1]),
            memory_extraction.TranscriptRef("verifier", "initial", sources[2]),
        ],
        tmp_path / "staged",
    )

    assert staged.entries == [
        (
            "analyzer initial",
            Path("/transcripts/0001-analyzer-initial.jsonl"),
        ),
        (
            "mitigator initial",
            Path("/transcripts/0002-mitigator-initial.jsonl"),
        ),
        (
            "verifier initial",
            Path("/transcripts/0003-verifier-initial.jsonl"),
        ),
    ]
    prompt = build_extractor_prompt(staged)
    assert "analyzer initial: `/transcripts/0001-analyzer-initial.jsonl`" in prompt
    assert "mitigator initial: `/transcripts/0002-mitigator-initial.jsonl`" in prompt
    assert "verifier initial: `/transcripts/0003-verifier-initial.jsonl`" in prompt
    assert str(tmp_path) not in prompt
    assert "source:" not in prompt
    assert "/transcripts/MANIFEST.md" not in prompt


def test_transcript_extraction_prompt_extracts_observation_only() -> None:
    """Keep output-schema internals out of the extractor's task message."""
    staged = StagedTranscripts(entries=[])
    user_prompt = build_extractor_prompt(staged)

    assert "has_observation" not in user_prompt
    assert "observation_markdown" not in user_prompt


def test_memory_maintenance_prompt_requires_an_observation() -> None:
    with pytest.raises(ValueError, match="requires at least one observation"):
        build_maintenance_prompt([])


def test_initialize_memory_store_seeds_external_memory(tmp_path: Path) -> None:
    memory_store_dir = tmp_path / "memory"

    memory_store.initialize_memory_store(memory_store_dir)

    assert (_memory_content_dir(memory_store_dir) / "MEMORY.md").is_file()
    assert (_memory_content_dir(memory_store_dir) / "topics").is_dir()
    assert (_memory_observations_dir(memory_store_dir)).is_dir()
    assert (memory_store_dir / "agent-transcripts" / "memory-extractor").is_dir()
    assert (memory_store_dir / "agent-transcripts" / "memory-maintainer").is_dir()
    assert (memory_store_dir / "memory_state.sqlite").is_file()
    assert list((_memory_content_dir(memory_store_dir) / "topics").iterdir()) == []
    assert (
        (_memory_content_dir(memory_store_dir) / "MEMORY.md")
        .read_text(encoding="utf-8")
        .strip()
    )


def test_memory_agent_transcript_paths_are_unique_and_non_overwriting(
    tmp_path: Path,
) -> None:
    memory_root = memory_store.initialize_memory_store(tmp_path / "memory")

    first = memory_agent_transcript_path(
        memory_root,
        agent_name="memory-extractor",
        run_label="Issue Review/run-1",
    )
    second = memory_agent_transcript_path(
        memory_root,
        agent_name="memory-extractor",
        run_label="Issue Review/run-1",
    )

    expected_root = memory_root / "agent-transcripts" / "memory-extractor"
    assert first.parent == expected_root
    assert second.parent == expected_root
    assert first.name.startswith("issue-review-run-1-")
    assert first.suffix == ".jsonl"
    assert first != second


def test_resolve_memory_store_dir_reads_environment(tmp_path: Path) -> None:
    with patch.dict(
        "os.environ",
        {memory_store.AGENT_MEMORY_DIR_ENV: str(tmp_path / "memory")},
        clear=False,
    ):
        resolved = memory_store.resolve_memory_store_dir(None, required=True)

    assert resolved == (tmp_path / "memory").resolve()


def test_resolve_memory_store_dir_prefers_cli_value(tmp_path: Path) -> None:
    with patch.dict(
        "os.environ",
        {memory_store.AGENT_MEMORY_DIR_ENV: str(tmp_path / "env-memory")},
        clear=False,
    ):
        resolved = memory_store.resolve_memory_store_dir(
            tmp_path / "cli-memory",
            required=True,
        )

    assert resolved == (tmp_path / "cli-memory").resolve()


def test_resolve_memory_store_dir_requires_configuration() -> None:
    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(ValueError, match="AGENT_MEMORY_DIR"),
    ):
        memory_store.resolve_memory_store_dir(None, required=True)


def test_resolve_memory_store_dir_ignores_consumption_toggle(
    tmp_path: Path,
) -> None:
    with patch.dict(
        "os.environ",
        {
            memory_store.AGENT_MEMORY_DIR_ENV: str(tmp_path / "memory"),
            AGENT_MEMORY_CONSUMPTION_ENABLED_ENV: "false",
        },
        clear=True,
    ):
        assert (
            memory_store.resolve_memory_store_dir(None, required=True)
            == (tmp_path / "memory").resolve()
        )


def test_memory_delete_file_tool_deletes_direct_topic_file(tmp_path: Path) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_store_dir)
    topic = _memory_content_dir(memory_store_dir) / "topics" / "obsolete.md"
    topic.write_text("merged elsewhere\n", encoding="utf-8")

    tool = build_memory_delete_file_tool(_memory_content_dir(memory_store_dir))
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
    memory_store_dir = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_store_dir)
    index = _memory_content_dir(memory_store_dir) / "MEMORY.md"
    index.write_text("index\n", encoding="utf-8")
    topic = _memory_content_dir(memory_store_dir) / "topics" / "obsolete.md"
    topic.write_text("topic\n", encoding="utf-8")

    tool = build_memory_delete_file_tool(_memory_content_dir(memory_store_dir))
    result = tool.invoke({"path": path})

    assert result["ok"] is False
    assert (_memory_content_dir(memory_store_dir) / "MEMORY.md").exists()
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
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
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
            path_views=[memory_view(host_path=_memory_content_dir(memory_root))],
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


def test_memory_index_hygiene_warning_reports_exceeded_startup_cap(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "\n".join(f"line {index}" for index in range(205)),
        encoding="utf-8",
    )

    warning = memory_maintenance._memory_index_hygiene_warning(memory_root)

    assert warning is not None
    assert "205/200 lines" in warning
    assert "exceeds startup cap" in warning


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


def test_dotenv_resolves_relative_memory_dir(tmp_path: Path, monkeypatch) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text('AGENT_MEMORY_DIR="memory"\n', encoding="utf-8")
    monkeypatch.delenv("AGENT_MEMORY_DIR", raising=False)

    load_dotenv_file(dotenv)

    assert os.environ["AGENT_MEMORY_DIR"] == str((tmp_path / "memory").resolve())


def test_materialize_configured_memory_view_copies_runtime_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    memory_root = tmp_path / "source-memory"
    topics_root = _memory_content_dir(memory_root) / "topics"
    topics_root.mkdir(parents=True)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "# Memory\n\n- Read `topics/path.md`.\n",
        encoding="utf-8",
    )
    (topics_root / "path.md").write_text("lesson\n", encoding="utf-8")
    (memory_root / ".lock").write_text("lock\n", encoding="utf-8")
    materialized_root = tmp_path / "materialized"
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(memory_root))
    monkeypatch.setenv(AGENT_MEMORY_MATERIALIZED_ROOT_ENV, str(materialized_root))

    snapshot = materialize_configured_memory_view()

    assert snapshot is not None
    assert snapshot.parent == materialized_root.resolve()
    assert snapshot != memory_root.resolve()
    assert (snapshot / "MEMORY.md").read_text(encoding="utf-8").startswith("# Memory")
    assert (snapshot / "topics" / "path.md").read_text(encoding="utf-8") == "lesson\n"
    assert not (snapshot / ".lock").exists()
    assert not (snapshot / "candidates").exists()

    (topics_root / "path.md").write_text("new lesson\n", encoding="utf-8")

    refreshed = materialize_configured_memory_view()

    assert refreshed is not None
    assert refreshed != snapshot
    assert (refreshed / "topics" / "path.md").read_text(
        encoding="utf-8"
    ) == "new lesson\n"
    assert (snapshot / "topics" / "path.md").read_text(encoding="utf-8") == "lesson\n"


def test_materialize_configured_memory_view_locks_source_during_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Prevent maintenance writes from producing a torn runtime snapshot."""
    memory_root = tmp_path / "source-memory"
    (_memory_content_dir(memory_root) / "topics").mkdir(parents=True)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "# Memory\n", encoding="utf-8"
    )
    materialized_root = tmp_path / "materialized"
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(memory_root))
    monkeypatch.setenv(AGENT_MEMORY_MATERIALIZED_ROOT_ENV, str(materialized_root))
    lock_calls: list[tuple[Path, bool]] = []

    @contextlib.contextmanager
    def fake_memory_store_lock(
        memory_store_dir: Path,
        *,
        exclusive: bool,
        blocking: bool = True,
    ):
        lock_calls.append((memory_store_dir, exclusive))
        yield True

    with patch(
        "sec_review_agents.memory.runtime_view.memory_store_lock",
        side_effect=fake_memory_store_lock,
    ):
        snapshot = materialize_configured_memory_view()

    assert snapshot is not None
    assert lock_calls == [(memory_root.resolve(), False)]


def test_materialize_coordinated_active_memory_tree_reference_by_digest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    materialized_root = tmp_path / "materialized"
    local_memory = tmp_path / "local-memory"
    local_memory.mkdir()
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(local_memory))
    monkeypatch.setenv(AGENT_MEMORY_MATERIALIZED_ROOT_ENV, str(materialized_root))
    reference = ArtifactReference(
        uri=f"s3://sec-review/memory/trees/{'a' * 64}/memory-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )
    catalog_client = Mock(
        active_revision=Mock(
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
    ):
        first = materialize_configured_memory_view()
        second = materialize_configured_memory_view()

    expected = materialized_root / f"memory-tree-{'a' * 64}" / "memory"
    assert first == expected
    assert second == expected
    assert (expected / "MEMORY.md").read_text(encoding="utf-8") == "# Coordinated\n"
    assert materialize_calls == [(reference, expected.parent)]


def test_coordinated_memory_without_active_revision_does_not_fall_back_locally(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    local_memory = memory_store.initialize_memory_store(tmp_path / "local-memory")
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(local_memory))
    catalog_client = Mock(
        active_revision=Mock(
            return_value={"revision": 0, "memory_tree_reference": None}
        )
    )

    with patch(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        return_value=catalog_client,
    ):
        assert materialize_configured_memory_view() is None
        assert not memory_runtime_available()


def test_memory_runtime_unavailable_without_initialized_index(
    tmp_path: Path,
    monkeypatch,
) -> None:
    memory_root = tmp_path / "source-memory"
    memory_root.mkdir()
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(memory_root))

    assert not memory_runtime_available()
    assert materialize_configured_memory_view() is None


@pytest.mark.asyncio
async def test_analysis_agent_enables_memory_when_runtime_memory_exists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "# Memory\n", encoding="utf-8"
    )
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(memory_root))
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
            "sec_review_agents.agents.analysis.agent.build_agent_runtime_graph",
            side_effect=fake_build_agent_runtime_graph,
        ),
    ):
        await create_analysis_agent_graph(
            agent_name="issue-analyzer",
            backend=LocalFilesystemBackend(tmp_path / "workspace"),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            mcp_tools=[],
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


def test_extraction_id_falls_back_to_transcript_hash() -> None:
    obs_id = memory_extraction.extraction_id([Path("/tmp/a.json"), Path("/tmp/b.json")])

    assert obs_id.startswith("transcripts-")
    assert len(obs_id) == len("transcripts-") + 16


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
async def test_extract_memory_observations_writes_observation_and_pending_state(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = tmp_path / "review" / "transcripts" / "0001-analyzer-initial.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(_transcript_jsonl("message"), encoding="utf-8")

    with (
        patch("sec_review_agents.memory.extractor.create_memory_extractor_agent_graph"),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            return_value={
                "has_observation": True,
                "observation_markdown": (
                    "Reusable lesson: keep verifier corrections visible."
                ),
            },
        ) as run_agent,
    ):
        result = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent],
            memory_store_dir=memory_root,
            deployment="test-deployment",
            job_id="issue-review-run-1",
            source_workflow="issue-review",
            run_id="run-1",
        )

    run_agent.assert_called_once()
    transcript_paths = run_agent.call_args.kwargs["transcript_paths"]
    assert len(transcript_paths) == 1
    assert transcript_paths[0].parent == (
        memory_root / "agent-transcripts" / "memory-extractor"
    )
    assert transcript_paths[0].name.startswith("issue-review-run-1-")
    assert result.skipped is False
    assert (
        result.observation_path
        == _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    )
    assert result.observation_path is not None
    observation_text = result.observation_path.read_text(encoding="utf-8")
    assert "# Memory Observation:" not in observation_text
    assert "## Provenance" in observation_text
    assert "## Observation\n\nReusable lesson:" in observation_text
    assert "- Source workflow: `issue-review`" in observation_text
    assert "- Run id: `run-1`" in observation_text
    assert "- Stages: analyzer initial" in observation_text
    assert str(transcript.resolve()) not in observation_text
    assert "## Source" not in observation_text
    assert "Reusable lesson: keep verifier corrections visible." in observation_text

    from sec_review_agents.memory.local_state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "pending"
    assert rows[0].path == str(result.observation_path)


@pytest.mark.asyncio
async def test_extract_memory_observations_repeated_id_updates_pending_row(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = tmp_path / "review" / "transcripts" / "0001-analyzer-initial.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(_transcript_jsonl("message"), encoding="utf-8")
    bodies = iter(["First durable lesson.", "Second durable lesson."])

    with (
        patch("sec_review_agents.memory.extractor.create_memory_extractor_agent_graph"),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            side_effect=lambda **_kwargs: {
                "has_observation": True,
                "observation_markdown": next(bodies),
            },
        ),
    ):
        first = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent],
            memory_store_dir=memory_root,
            extraction_id_value="same-run",
        )
        second = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent],
            memory_store_dir=memory_root,
            extraction_id_value="same-run",
        )

    assert first.observation_path == second.observation_path
    assert second.observation_path is not None
    assert "Second durable lesson." in second.observation_path.read_text(
        encoding="utf-8"
    )

    from sec_review_agents.memory.local_state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["same-run"])
    assert len(rows) == 1
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_extract_memory_observations_sanitizes_explicit_extraction_id(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = tmp_path / "review" / "transcripts" / "0001-analyzer-initial.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(_transcript_jsonl("message"), encoding="utf-8")

    with (
        patch("sec_review_agents.memory.extractor.create_memory_extractor_agent_graph"),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            return_value={
                "has_observation": True,
                "observation_markdown": "Reusable lesson.",
            },
        ),
    ):
        result = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent],
            memory_store_dir=memory_root,
            extraction_id_value="../Unsafe/Extraction ID",
        )

    assert result.observation_path == (
        _memory_observations_dir(memory_root) / "unsafe-extraction-id.md"
    )
    assert result.observation_path is not None
    assert result.observation_path.is_file()
    assert not (memory_root / "Unsafe").exists()
    assert not (memory_root.parent / "Unsafe").exists()

    from sec_review_agents.memory.local_state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(
            connection, ["unsafe-extraction-id"]
        )
    assert len(rows) == 1
    assert rows[0].path == str(result.observation_path)


@pytest.mark.asyncio
async def test_extract_memory_observations_skips_processed_observation_by_default(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = tmp_path / "review" / "transcripts" / "0001-analyzer-initial.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(_transcript_jsonl("message"), encoding="utf-8")
    observation = _memory_observations_dir(memory_root) / "same-run.md"
    observation.parent.mkdir(parents=True, exist_ok=True)
    observation.write_text("Original durable lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="same-run",
            path=str(observation),
            status="processed",
        )

    with (
        patch(
            "sec_review_agents.memory.extractor.create_memory_extractor_agent_graph"
        ) as create_agent,
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph"
        ) as run_agent,
    ):
        result = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent],
            memory_store_dir=memory_root,
            extraction_id_value="same-run",
        )

    create_agent.assert_not_called()
    run_agent.assert_not_called()
    assert result.skipped is True
    assert result.observation_paths == (observation,)
    assert observation.read_text(encoding="utf-8") == "Original durable lesson.\n"
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["same-run"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_extract_memory_observations_skips_publish_when_observation_processed_during_run(
    tmp_path: Path,
) -> None:
    """Do not republish work that another maintainer consumed during extraction."""
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = tmp_path / "review" / "transcripts" / "0001-analyzer-initial.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(_transcript_jsonl("message"), encoding="utf-8")
    observation = _memory_observations_dir(memory_root) / "same-run.md"
    observation.parent.mkdir(parents=True, exist_ok=True)
    observation.write_text("Maintained lesson.\n", encoding="utf-8")

    @contextlib.contextmanager
    def mark_processed_before_publish(
        _memory_store_dir: Path,
        *,
        exclusive: bool,
        blocking: bool = True,
    ):
        assert exclusive is True
        assert blocking is True
        with memory_extraction.open_memory_state(memory_root) as connection:
            memory_extraction.upsert_observation(
                connection,
                extraction_id="same-run",
                path=str(observation),
                status="processed",
            )
        yield True

    with (
        patch("sec_review_agents.memory.extractor.create_memory_extractor_agent_graph"),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            return_value={
                "has_observation": True,
                "observation_markdown": "Late replacement lesson.",
            },
        ) as run_agent,
        patch(
            "sec_review_agents.memory.extractor.memory_store_lock",
            side_effect=mark_processed_before_publish,
        ),
    ):
        result = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent],
            memory_store_dir=memory_root,
            extraction_id_value="same-run",
        )

    run_agent.assert_called_once()
    assert result.skipped is True
    assert result.observation_paths == (observation,)
    assert observation.read_text(encoding="utf-8") == "Maintained lesson.\n"
    with memory_extraction.open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["same-run"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_maintain_memory_marks_observations_processed(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson: lower confidence.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    def fake_invoke_agent_runtime_graph(*, user_prompt, **_kwargs):
        assert (
            "`issue-review-run-1`: `/memory/observations/issue-review-run-1.md`"
            in user_prompt
        )
        transcript_paths = _kwargs["transcript_paths"]
        assert len(transcript_paths) == 1
        assert transcript_paths[0].parent == (
            memory_root / "agent-transcripts" / "memory-maintainer"
        )
        assert transcript_paths[0].name.startswith("maintenance-")
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
        )

    assert result.processed_count == 1
    assert observation.exists()
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_maintain_memory_selected_ids_limit_prompt_and_worktree(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observations_root = _memory_observations_dir(memory_root)

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        for extraction_id in ("first", "second", "unselected"):
            path = observations_root / f"{extraction_id}.md"
            path.write_text(f"{extraction_id} lesson.\n", encoding="utf-8")
            upsert_observation(
                connection,
                extraction_id=extraction_id,
                path=str(path),
                status="pending",
            )

    captured_worktree: Path | None = None

    async def fake_create_agent_graph(*, worktree_root: Path, **_kwargs):
        nonlocal captured_worktree
        captured_worktree = worktree_root
        return object()

    async def fake_invoke_agent_runtime_graph(*, user_prompt, **_kwargs):
        assert user_prompt.index("`second`") < user_prompt.index("`first`")
        assert "`unselected`" not in user_prompt
        assert captured_worktree is not None
        staged_names = sorted(
            path.name for path in (captured_worktree / "observations").iterdir()
        )
        assert staged_names == ["first.md", "second.md"]
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph",
            side_effect=fake_create_agent_graph,
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
            extraction_ids=["second", "first"],
        )

    assert result.processed_count == 2
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(
            connection,
            ["first", "second", "unselected"],
        )
    statuses = {row.extraction_id: row.status for row in rows}
    assert statuses == {
        "first": "processed",
        "second": "processed",
        "unselected": "pending",
    }


@pytest.mark.asyncio
async def test_maintain_memory_selected_ids_reject_unknown_or_processed(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "processed.md"
    observation.write_text("Processed lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="processed",
            path=str(observation),
            status="processed",
        )

    with pytest.raises(ValueError, match="Unknown memory extraction ids: missing"):
        await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            extraction_ids=["missing"],
        )
    with pytest.raises(
        ValueError,
        match=r"Selected memory observations must be pending: processed \(processed\)",
    ):
        await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            extraction_ids=["processed"],
        )


@pytest.mark.asyncio
async def test_maintain_memory_empty_selected_ids_is_noop(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ) as create_agent,
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph"
        ) as run_agent,
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            extraction_ids=[],
        )

    assert result.processed_count == 0
    assert result.skipped is False
    create_agent.assert_not_called()
    run_agent.assert_not_called()


@pytest.mark.asyncio
async def test_maintain_memory_does_not_process_rewritten_observation(
    tmp_path: Path,
) -> None:
    """Leave a concurrently rewritten observation pending for a later maintenance run."""
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "same-run.md"
    observation.write_text("Old lesson selected by maintenance.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="same-run",
            path=str(observation),
            status="pending",
        )

    def rewrite_observation_while_maintenance_runs(**_kwargs):
        observation.write_text("New lesson from rerun extraction.\n", encoding="utf-8")
        with open_memory_state(memory_root) as connection:
            upsert_observation(
                connection,
                extraction_id="same-run",
                path=str(observation),
                status="pending",
            )
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=rewrite_observation_while_maintenance_runs,
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root
        )

    assert result.processed_count == 0
    assert (
        observation.read_text(encoding="utf-8") == "New lesson from rerun extraction.\n"
    )
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["same-run"])
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_maintain_memory_updates_worktree_then_publishes_memory(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "old index\n", encoding="utf-8"
    )
    old_topic = _memory_content_dir(memory_root) / "topics" / "old.md"
    old_topic.write_text("old topic\n", encoding="utf-8")
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    def fake_create_agent_graph(**kwargs):
        worktree = kwargs["backend"].routes["/memory/"].root_dir
        assert worktree != memory_root
        assert (worktree / "MEMORY.md").read_text(encoding="utf-8") == "old index\n"
        return Mock(backend=kwargs["backend"])

    def fake_invoke_agent_runtime_graph(*, agent, **_kwargs):
        worktree = agent.backend.routes["/memory/"].root_dir
        (worktree / "MEMORY.md").write_text("new index\n", encoding="utf-8")
        (worktree / "topics" / "old.md").unlink()
        (worktree / "topics" / "new.md").write_text(
            "new topic\n",
            encoding="utf-8",
        )
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph",
            side_effect=fake_create_agent_graph,
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
        )

    assert result.processed_count == 1
    assert (_memory_content_dir(memory_root) / "MEMORY.md").read_text(
        encoding="utf-8"
    ) == "new index\n"
    assert not old_topic.exists()
    assert (_memory_content_dir(memory_root) / "topics" / "new.md").read_text(
        encoding="utf-8"
    ) == ("new topic\n")
    assert observation.exists()
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_maintain_memory_summary_warns_when_index_exceeds_startup_cap(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "\n".join(f"line {index}" for index in range(205)) + "\n",
        encoding="utf-8",
    )
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            return_value={"done": True},
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
        )

    assert result.processed_count == 1
    assert "exceeds startup cap" in result.summary


@pytest.mark.asyncio
async def test_maintain_memory_no_pending_summary_warns_when_index_exceeds_startup_cap(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "\n".join(f"line {index}" for index in range(205)) + "\n",
        encoding="utf-8",
    )

    result = await memory_maintenance.maintain_memory_with_result(
        memory_store_dir=memory_root,
        deployment="test-deployment",
    )

    assert result.processed_count == 0
    assert "No pending memory observations selected." in result.summary
    assert "exceeds startup cap" in result.summary


@pytest.mark.asyncio
async def test_maintain_memory_releases_source_lock_while_agent_runs(
    tmp_path: Path,
) -> None:
    """Avoid blocking memory readers and writers during the slow model call."""
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    def fake_invoke_agent_runtime_graph(**_kwargs):
        with memory_store.memory_store_lock(
            memory_root,
            exclusive=False,
            blocking=False,
        ) as lock_acquired:
            assert lock_acquired is True
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
        )

    assert result.processed_count == 1


@pytest.mark.asyncio
async def test_maintenance_singleton_lock_waits_without_blocking_event_loop(
    tmp_path: Path,
) -> None:
    """Serialize maintainers without stalling unrelated asynchronous work."""
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    lock_path = memory_root / memory_maintenance.MEMORY_MAINTENANCE_LOCK_FILENAME

    holder = lock_path.open("a+", encoding="utf-8")
    fcntl.flock(holder.fileno(), fcntl.LOCK_EX)
    acquired = False

    async def wait_for_lock() -> None:
        nonlocal acquired
        async with memory_maintenance._maintenance_singleton_lock(memory_root):
            acquired = True

    try:
        waiter = asyncio.create_task(wait_for_lock())
        await asyncio.sleep(memory_maintenance.MEMORY_MAINTENANCE_LOCK_POLL_SECONDS * 2)
        assert not waiter.done()
        assert acquired is False

        fcntl.flock(holder.fileno(), fcntl.LOCK_UN)
        await asyncio.wait_for(waiter, timeout=1)
    finally:
        holder.close()

    assert acquired is True


@pytest.mark.asyncio
async def test_maintain_memory_respects_batch_size(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    first = _memory_observations_dir(memory_root) / "first.md"
    second = _memory_observations_dir(memory_root) / "second.md"
    first.write_text("First lesson.\n", encoding="utf-8")
    second.write_text("Second lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="first",
            path=str(first),
            status="pending",
        )
        upsert_observation(
            connection,
            extraction_id="second",
            path=str(second),
            status="pending",
        )

    def fake_invoke_agent_runtime_graph(*, user_prompt, **_kwargs):
        assert "`first`: `/memory/observations/first.md`" in user_prompt
        assert "`second`: `/memory/observations/second.md`" not in user_prompt
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
            batch_size=1,
        )

    assert result.processed_count == 1
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["first", "second"])
    statuses = {row.extraction_id: row.status for row in rows}
    assert statuses == {"first": "processed", "second": "pending"}


@pytest.mark.asyncio
async def test_maintain_memory_rejects_missing_pending_observation_file(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    missing = _memory_observations_dir(memory_root) / "missing.md"

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="missing",
            path=str(missing),
            status="pending",
        )

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ) as create_agent,
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph"
        ) as run_agent,
        pytest.raises(FileNotFoundError, match="missing"),
    ):
        await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
        )

    create_agent.assert_not_called()
    run_agent.assert_not_called()
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["missing"])
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_maintain_memory_leaves_observations_pending_on_exception(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson: lower confidence.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=RuntimeError("maintenance failed"),
        ),
    ):
        try:
            await memory_maintenance.maintain_memory_with_result(
                memory_store_dir=memory_root,
                deployment="test-deployment",
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError("maintenance failure was not raised")

    assert observation.exists()
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_maintain_memory_retries_pending_observation_after_failure(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson: lower confidence.\n", encoding="utf-8")

    from sec_review_agents.memory.local_state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            extraction_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    attempts = {"count": 0}

    def fake_invoke_agent_runtime_graph(*, user_prompt, **_kwargs):
        attempts["count"] += 1
        assert (
            "`issue-review-run-1`: `/memory/observations/issue-review-run-1.md`"
            in user_prompt
        )
        if attempts["count"] == 1:
            raise RuntimeError("maintenance failed")
        return {"done": True}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph"
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        try:
            await memory_maintenance.maintain_memory_with_result(
                memory_store_dir=memory_root,
                deployment="test-deployment",
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError("maintenance failure was not raised")

        result = await memory_maintenance.maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment="test-deployment",
        )

    assert result.processed_count == 1
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_extraction_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_analysis_agent_leaves_memory_disabled_when_runtime_memory_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.delenv(AGENT_MEMORY_DIR_ENV, raising=False)
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
            "sec_review_agents.agents.analysis.agent.build_agent_runtime_graph",
            side_effect=fake_build_agent_runtime_graph,
        ),
    ):
        await create_analysis_agent_graph(
            agent_name="issue-analyzer",
            backend=LocalFilesystemBackend(tmp_path / "workspace"),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            mcp_tools=[],
        )

    assert not any(isinstance(item, MemoryMiddleware) for item in captured_middleware)
