import asyncio
import contextlib
import fcntl
import os
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from deepagents.backends import CompositeBackend
from langchain.agents.middleware.types import ModelRequest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel

from sec_review_agents.agents.memory_extractor.model import StagedTranscripts
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
    build_extractor_prompt,
)
from sec_review_agents.agents.memory_maintainer.prompts import (
    MEMORY_MAINTAINER_SYSTEM_PROMPT,
    build_maintenance_prompt,
)
from sec_review_agents.agents.memory_maintainer.tools import (
    build_memory_delete_file_tool,
)
from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend
from sec_review_agents.filesystem.material_views import (
    memory_view,
    writable_memory_view,
)
from sec_review_agents.memory import extractor as memory_extraction
from sec_review_agents.memory import maintainer as memory_maintenance
from sec_review_agents.memory import store as memory_store
from sec_review_agents.memory.middleware import (
    DEFAULT_MEMORY_INDEX_MAX_CHARS,
    DEFAULT_MEMORY_INDEX_MAX_LINES,
    MemoryMiddleware,
)
from sec_review_agents.memory.store import (
    AGENT_MEMORY_DIR_ENV,
    AGENT_MEMORY_ENABLED_ENV,
    AGENT_MEMORY_MATERIALIZED_ROOT_ENV,
    materialize_configured_memory_view,
    memory_runtime_available,
)
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.utils.env import load_dotenv_file
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


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


def _fetch_observations_by_ids(connection, observation_ids: list[str]):
    if not observation_ids:
        return []
    placeholders = ",".join("?" for _ in observation_ids)
    rows = connection.execute(
        f"""
        select
          observation_id,
          path,
          status,
          created_at,
          updated_at
        from observations
        where observation_id in ({placeholders})
        order by created_at asc, observation_id asc
        """,
        observation_ids,
    ).fetchall()
    from sec_review_agents.memory.state import ObservationRow

    return [ObservationRow(*row) for row in rows]


def _memory_content_dir(memory_store_dir: Path) -> Path:
    return memory_store.memory_content_dir(memory_store_dir)


def _memory_observations_dir(memory_store_dir: Path) -> Path:
    return memory_store.memory_observations_dir(memory_store_dir)


def test_stage_transcripts_copies_jsonl_under_thread_dir(tmp_path: Path) -> None:
    source = tmp_path / "run" / "transcript.jsonl"
    source.parent.mkdir()
    source.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
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
            "0001-review",
            "transcript",
            Path("/transcripts/0001-review/0001-transcript.jsonl"),
        )
    ]
    assert (destination / "0001-review" / "0001-transcript.jsonl").read_text(
        encoding="utf-8"
    ) == ('{"seq":1,"event":"message"}\n')
    assert not (destination / "MANIFEST.md").exists()


def test_collect_review_memory_transcripts_uses_published_threads(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    published = (
        review_root / "transcripts" / "0001-review" / "0001-analyzer-initial.jsonl"
    )
    unrelated = review_root / "notes" / "scratch.jsonl"
    published.parent.mkdir(parents=True)
    unrelated.parent.mkdir(parents=True)
    published.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
    unrelated.write_text('{"seq":1,"event":"scratch"}\n', encoding="utf-8")

    refs = memory_extraction.collect_review_memory_transcripts(review_root)

    assert [(ref.thread, ref.stage, ref.attempt, ref.path) for ref in refs] == [
        (
            "0001-review",
            "analyzer",
            "initial",
            published.resolve(),
        )
    ]


def test_collect_review_memory_transcripts_rejects_invalid_published_name(
    tmp_path: Path,
) -> None:
    review_root = tmp_path / "review"
    transcript = review_root / "transcripts" / "0001-review" / "analyzer.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="<order>-<stage>-<attempt>"):
        memory_extraction.collect_review_memory_transcripts(review_root)


def test_stage_review_transcripts_writes_ordered_thread_prompt(tmp_path: Path) -> None:
    sources = []
    for label in ("analyzer", "mitigator", "verifier"):
        path = tmp_path / f"{label}.jsonl"
        path.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
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
            "0001-review",
            "analyzer initial",
            Path("/transcripts/0001-review/0001-analyzer-initial.jsonl"),
        ),
        (
            "0001-review",
            "mitigator initial",
            Path("/transcripts/0001-review/0002-mitigator-initial.jsonl"),
        ),
        (
            "0001-review",
            "verifier initial",
            Path("/transcripts/0001-review/0003-verifier-initial.jsonl"),
        ),
    ]
    prompt = build_extractor_prompt(staged)
    assert "- Thread `0001-review`" in prompt
    assert (
        "analyzer initial: `/transcripts/0001-review/0001-analyzer-initial.jsonl`"
        in prompt
    )
    assert (
        "mitigator initial: `/transcripts/0001-review/0002-mitigator-initial.jsonl`"
        in prompt
    )
    assert (
        "verifier initial: `/transcripts/0001-review/0003-verifier-initial.jsonl`"
        in prompt
    )
    assert str(tmp_path) not in prompt
    assert "source:" not in prompt
    assert "/transcripts/MANIFEST.md" not in prompt


def test_extractor_prompt_rejects_one_off_provenance_details() -> None:
    system_prompt = MEMORY_EXTRACTOR_SYSTEM_PROMPT

    assert "durable pattern level" in system_prompt
    assert "one-run identifiers" in system_prompt
    assert "copied source code" in system_prompt
    assert "sensitive values" in system_prompt
    assert "contamination check" in system_prompt
    assert "prompt snapshots or prior context" in system_prompt


def test_maintenance_prompt_keeps_index_short_and_topics_substantive() -> None:
    system_prompt = MEMORY_MAINTAINER_SYSTEM_PROMPT

    assert "startup-injected memory index" in system_prompt
    assert "Keep it short, dense, and route-oriented" in system_prompt
    assert "substantive rules, patterns, cautions, and examples" in system_prompt
    assert "/memory/topics/*.md" in system_prompt


def test_transcript_extraction_prompt_extracts_observation_only() -> None:
    staged = StagedTranscripts(entries=[])
    user_prompt = build_extractor_prompt(staged)

    assert "Transcript Inputs" in user_prompt
    assert "return one short Markdown observation" in user_prompt
    assert "return no observation" in user_prompt
    assert "has_observation" not in user_prompt
    assert "observation_markdown" not in user_prompt
    assert "contamination check" not in user_prompt
    assert "prompt snapshots" not in user_prompt


def test_extractor_prompt_reads_middleware_injected_context() -> None:
    system_prompt = MEMORY_EXTRACTOR_SYSTEM_PROMPT

    assert "transcript context" in system_prompt
    assert "prompt snapshots and model-call messages" in system_prompt
    assert "prompt snapshots or prior context" in system_prompt
    assert "prompt, memory, or skill" not in system_prompt


def test_memory_maintenance_prompt_does_not_learn_new_facts() -> None:
    maintenance_system_prompt = MEMORY_MAINTAINER_SYSTEM_PROMPT
    maintenance_user_prompt = build_maintenance_prompt([])

    assert "No raw transcripts" in maintenance_system_prompt
    assert "Do not create new security-review lessons" in maintenance_system_prompt
    assert (
        "Only reorganize, compress, merge, split, rename, or clarify"
        in maintenance_system_prompt
    )
    assert "selected observation files" in maintenance_system_prompt
    assert (
        "incorporate durable lessons from selected observation files"
        in maintenance_system_prompt
    )
    assert "Be more willing to compress than to preserve" in maintenance_system_prompt
    assert "delete_file" not in maintenance_system_prompt
    assert "Selected Observations" in maintenance_user_prompt
    assert "leave memory unchanged" in maintenance_user_prompt


def test_initialize_memory_store_seeds_external_memory(tmp_path: Path) -> None:
    memory_store_dir = tmp_path / "memory"

    memory_store.initialize_memory_store(memory_store_dir)

    assert (_memory_content_dir(memory_store_dir) / "MEMORY.md").is_file()
    assert (_memory_content_dir(memory_store_dir) / "topics").is_dir()
    assert (_memory_observations_dir(memory_store_dir)).is_dir()
    assert (memory_store_dir / "memory_state.sqlite").is_file()
    assert list((_memory_content_dir(memory_store_dir) / "topics").iterdir()) == []
    index = (_memory_content_dir(memory_store_dir) / "MEMORY.md").read_text(
        encoding="utf-8"
    )
    assert "Use the top of this file as the runtime index" in index


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


def test_resolve_memory_store_dir_respects_global_disable() -> None:
    with (
        patch.dict("os.environ", {AGENT_MEMORY_ENABLED_ENV: "false"}, clear=True),
        pytest.raises(ValueError, match="Memory is disabled"),
    ):
        memory_store.resolve_memory_store_dir(None, required=True)

    with patch.dict("os.environ", {AGENT_MEMORY_ENABLED_ENV: "false"}, clear=True):
        assert memory_store.resolve_memory_store_dir(None, required=False) is None


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


def test_memory_middleware_injects_read_only_usage_rules() -> None:
    request = ModelRequest(
        model=FakeMessagesListChatModel(responses=[]),
        messages=[],
        system_prompt="Base prompt.",
    )

    modified = MemoryMiddleware().modify_request(request)

    assert modified.system_prompt is not None
    assert "Base prompt." in modified.system_prompt
    assert "/memory/MEMORY.md" in modified.system_prompt
    assert "Use this memory as guidance only" in modified.system_prompt
    assert "Do not write to" in modified.system_prompt
    assert "not evidence for the current repository" in modified.system_prompt


def test_memory_middleware_default_index_cap_matches_claude_code_style() -> None:
    assert DEFAULT_MEMORY_INDEX_MAX_LINES == 200
    assert DEFAULT_MEMORY_INDEX_MAX_CHARS == 25_000


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
        backend = create_backend_with_materials(
            container_name_prefix="memory-test",
            material_views=[memory_view(host_path=_memory_content_dir(memory_root))],
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
        backend = create_backend_with_materials(
            container_name_prefix="memory-test",
            material_views=[memory_view(host_path=memory_root)],
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
        backend = create_backend_with_materials(
            container_name_prefix="memory-test",
            material_views=[writable_memory_view(host_path=memory_root)],
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
        "sec_review_agents.memory.store.memory_store_lock",
        side_effect=fake_memory_store_lock,
    ):
        snapshot = materialize_configured_memory_view()

    assert snapshot is not None
    assert lock_calls == [(memory_root.resolve(), False)]


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
async def test_review_stage_enables_memory_when_runtime_memory_exists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    (_memory_content_dir(memory_root) / "MEMORY.md").write_text(
        "# Memory\n", encoding="utf-8"
    )
    monkeypatch.setenv(AGENT_MEMORY_DIR_ENV, str(memory_root))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=workspace,
        tar_path=snapshot_tar,
    )
    captured_kwargs: dict = {}

    async def fake_create_agent_graph(**kwargs):
        captured_kwargs.update(kwargs)
        return object()

    async def fake_invoke_agent_runtime_graph(**_kwargs):
        return {
            "overview": "ok",
            "narratives": [],
            "overall_verdict": "no-actionable-finding",
        }

    with (
        patch(
            "sec_review_agents.review_stages.analysis.stage.create_analysis_agent_graph",
            side_effect=fake_create_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        await run_analysis_stage(
            analyzer_artifacts_path=tmp_path / "artifacts",
            agent_name="issue-analyzer",
            baseline_snapshot_tar_path=snapshot_tar,
            build_backend=lambda stage_workspace_path: LocalFilesystemBackend(
                stage_workspace_path
            ),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
        )

    assert captured_kwargs["agent_name"] == "issue-analyzer"


def test_observation_id_uses_source_workflow_and_run_id() -> None:
    assert (
        memory_extraction.observation_id(
            [Path("/tmp/a.jsonl")],
            source_workflow="Issue Review",
            run_id="run-1",
        )
        == "issue-review-run-1"
    )


def test_observation_id_falls_back_to_transcript_hash() -> None:
    obs_id = memory_extraction.observation_id(
        [Path("/tmp/a.jsonl"), Path("/tmp/b.jsonl")]
    )

    assert obs_id.startswith("transcripts-")
    assert len(obs_id) == len("transcripts-") + 16


@pytest.mark.asyncio
async def test_extract_memory_observations_writes_observation_and_pending_state(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = (
        tmp_path
        / "review"
        / "transcripts"
        / "0001-review"
        / "0001-analyzer-initial.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")

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
            [transcript.parent.parent.parent],
            memory_store_dir=memory_root,
            deployment="test-deployment",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path=transcript.parent.parent.parent,
        )

    run_agent.assert_called_once()
    assert result.skipped is False
    assert (
        result.observation_path
        == _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    )
    assert result.observation_path is not None
    observation_text = result.observation_path.read_text(encoding="utf-8")
    assert "# Memory Observation: issue-review-run-1" in observation_text
    assert "## Provenance" in observation_text
    assert "- Source workflow: `issue-review`" in observation_text
    assert "- Run id: `run-1`" in observation_text
    assert "- Artifact root name: `review`" in observation_text
    assert "- Thread: `0001-review`" in observation_text
    assert "- Stages: analyzer initial" in observation_text
    assert str(transcript.resolve()) not in observation_text
    assert "## Source" not in observation_text
    assert "Reusable lesson: keep verifier corrections visible." in observation_text

    from sec_review_agents.memory.state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "pending"
    assert rows[0].path == str(result.observation_path)


@pytest.mark.asyncio
async def test_extract_memory_observations_repeated_id_updates_pending_row(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = (
        tmp_path
        / "review"
        / "transcripts"
        / "0001-review"
        / "0001-analyzer-initial.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
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
            [transcript.parent.parent.parent],
            memory_store_dir=memory_root,
            observation_id_value="same-run",
        )
        second = await memory_extraction.extract_memory_observations_from_paths(
            [transcript.parent.parent.parent],
            memory_store_dir=memory_root,
            observation_id_value="same-run",
        )

    assert first.observation_path == second.observation_path
    assert second.observation_path is not None
    assert "Second durable lesson." in second.observation_path.read_text(
        encoding="utf-8"
    )

    from sec_review_agents.memory.state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(connection, ["same-run"])
    assert len(rows) == 1
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_extract_memory_observations_sanitizes_explicit_observation_id(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = (
        tmp_path
        / "review"
        / "transcripts"
        / "0001-review"
        / "0001-analyzer-initial.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")

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
            [transcript.parent.parent.parent],
            memory_store_dir=memory_root,
            observation_id_value="../Unsafe/Observation ID",
        )

    assert result.observation_path == (
        _memory_observations_dir(memory_root) / "unsafe-observation-id.md"
    )
    assert result.observation_path is not None
    assert result.observation_path.is_file()
    assert not (memory_root / "Unsafe").exists()
    assert not (memory_root.parent / "Unsafe").exists()

    from sec_review_agents.memory.state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(connection, ["unsafe-observation-id"])
    assert len(rows) == 1
    assert rows[0].path == str(result.observation_path)


@pytest.mark.asyncio
async def test_extract_memory_observations_runs_once_per_published_thread(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    artifacts = tmp_path / "review"
    first = (
        artifacts / "transcripts" / "0001-case-alpha" / "0001-analyzer-initial.jsonl"
    )
    second = (
        artifacts / "transcripts" / "0002-case-beta" / "0001-analyzer-initial.jsonl"
    )
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
    second.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
    prompts: list[str] = []
    bodies = iter(["Alpha lesson.", "Beta lesson."])

    def _run_agent(*, user_prompt, **_kwargs):
        prompts.append(user_prompt)
        return {
            "has_observation": True,
            "observation_markdown": next(bodies),
        }

    with (
        patch(
            "sec_review_agents.memory.extractor.create_memory_extractor_agent_graph"
        ) as create_agent,
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            side_effect=_run_agent,
        ),
    ):
        result = await memory_extraction.extract_memory_observations_from_paths(
            [artifacts],
            memory_store_dir=memory_root,
            observation_id_value="repo-run",
        )

    assert create_agent.call_count == 2
    assert len(prompts) == 2
    assert "0001-case-alpha" in prompts[0]
    assert "0002-case-beta" not in prompts[0]
    assert "0002-case-beta" in prompts[1]
    assert "0001-case-alpha" not in prompts[1]
    assert result.skipped is False
    assert result.summary == "Memory observations written: 2; threads skipped: 0."
    assert result.observation_paths == (
        _memory_observations_dir(memory_root) / "repo-run-0001-case-alpha.md",
        _memory_observations_dir(memory_root) / "repo-run-0002-case-beta.md",
    )
    assert "Alpha lesson." in result.observation_paths[0].read_text(encoding="utf-8")
    assert "Beta lesson." in result.observation_paths[1].read_text(encoding="utf-8")

    from sec_review_agents.memory.state import open_memory_state

    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(
            connection,
            ["repo-run-0001-case-alpha", "repo-run-0002-case-beta"],
        )
    assert [row.status for row in rows] == ["pending", "pending"]


@pytest.mark.asyncio
async def test_extract_memory_observations_skips_processed_observation_by_default(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = (
        tmp_path
        / "review"
        / "transcripts"
        / "0001-review"
        / "0001-analyzer-initial.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
    observation = _memory_observations_dir(memory_root) / "same-run.md"
    observation.parent.mkdir(parents=True, exist_ok=True)
    observation.write_text("Original durable lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.state import open_memory_state, upsert_observation

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="same-run",
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
            [transcript.parent.parent.parent],
            memory_store_dir=memory_root,
            observation_id_value="same-run",
        )

    create_agent.assert_not_called()
    run_agent.assert_not_called()
    assert result.skipped is True
    assert result.observation_paths == ()
    assert observation.read_text(encoding="utf-8") == "Original durable lesson.\n"
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(connection, ["same-run"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_extract_memory_observations_skips_publish_when_observation_processed_during_run(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    transcript = (
        tmp_path
        / "review"
        / "transcripts"
        / "0001-review"
        / "0001-analyzer-initial.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"seq":1,"event":"message"}\n', encoding="utf-8")
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
                observation_id="same-run",
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
            [transcript.parent.parent.parent],
            memory_store_dir=memory_root,
            observation_id_value="same-run",
        )

    run_agent.assert_called_once()
    assert result.skipped is True
    assert result.observation_paths == ()
    assert observation.read_text(encoding="utf-8") == "Maintained lesson.\n"
    with memory_extraction.open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(connection, ["same-run"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_maintain_memory_marks_observations_processed(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson: lower confidence.\n", encoding="utf-8")

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="issue-review-run-1",
            path=str(observation),
            status="pending",
        )

    def fake_invoke_agent_runtime_graph(*, user_prompt, **_kwargs):
        assert (
            "`issue-review-run-1`: `/memory/observations/issue-review-run-1.md`"
            in user_prompt
        )
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
        rows = _fetch_observations_by_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_maintain_memory_does_not_process_rewritten_observation(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "same-run.md"
    observation.write_text("Old lesson selected by maintenance.\n", encoding="utf-8")

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="same-run",
            path=str(observation),
            status="pending",
        )

    def rewrite_observation_while_maintenance_runs(**_kwargs):
        observation.write_text("New lesson from rerun extraction.\n", encoding="utf-8")
        with open_memory_state(memory_root) as connection:
            upsert_observation(
                connection,
                observation_id="same-run",
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
        rows = _fetch_observations_by_ids(connection, ["same-run"])
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

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="issue-review-run-1",
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
        rows = _fetch_observations_by_ids(connection, ["issue-review-run-1"])
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

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="issue-review-run-1",
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
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson.\n", encoding="utf-8")

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="issue-review-run-1",
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

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="first",
            path=str(first),
            status="pending",
        )
        upsert_observation(
            connection,
            observation_id="second",
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
        rows = _fetch_observations_by_ids(connection, ["first", "second"])
    statuses = {row.observation_id: row.status for row in rows}
    assert statuses == {"first": "processed", "second": "pending"}


@pytest.mark.asyncio
async def test_maintain_memory_rejects_missing_pending_observation_file(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    missing = _memory_observations_dir(memory_root) / "missing.md"

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="missing",
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
        rows = _fetch_observations_by_ids(connection, ["missing"])
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_maintain_memory_leaves_observations_pending_on_exception(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson: lower confidence.\n", encoding="utf-8")

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="issue-review-run-1",
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
        rows = _fetch_observations_by_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "pending"


@pytest.mark.asyncio
async def test_maintain_memory_retries_pending_observation_after_failure(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_root)
    observation = _memory_observations_dir(memory_root) / "issue-review-run-1.md"
    observation.write_text("Reusable lesson: lower confidence.\n", encoding="utf-8")

    from sec_review_agents.memory.state import (
        open_memory_state,
        upsert_observation,
    )

    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="issue-review-run-1",
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
        rows = _fetch_observations_by_ids(connection, ["issue-review-run-1"])
    assert rows[0].status == "processed"


@pytest.mark.asyncio
async def test_review_stage_leaves_memory_disabled_when_runtime_memory_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.delenv(AGENT_MEMORY_DIR_ENV, raising=False)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=workspace,
        tar_path=snapshot_tar,
    )
    captured_kwargs: dict = {}

    async def fake_create_agent_graph(**kwargs):
        captured_kwargs.update(kwargs)
        return object()

    async def fake_invoke_agent_runtime_graph(**_kwargs):
        return {
            "overview": "ok",
            "narratives": [],
            "overall_verdict": "no-actionable-finding",
        }

    with (
        patch(
            "sec_review_agents.review_stages.analysis.stage.create_analysis_agent_graph",
            side_effect=fake_create_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.analysis.stage.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
    ):
        await run_analysis_stage(
            analyzer_artifacts_path=tmp_path / "artifacts",
            agent_name="issue-analyzer",
            baseline_snapshot_tar_path=snapshot_tar,
            build_backend=lambda stage_workspace_path: LocalFilesystemBackend(
                stage_workspace_path
            ),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
        )

    assert captured_kwargs["agent_name"] == "issue-analyzer"
