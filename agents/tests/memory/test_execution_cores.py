from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.coordinated_maintenance import (
    prepare_coordinated_memory_revision,
)
from sec_review_agents.memory.extractor import preview_memory_observation_from_paths
from sec_review_agents.memory.maintainer import maintain_memory_tree
from sec_review_agents.memory.memory_tree_artifact import (
    materialize_memory_tree,
    publish_memory_tree_artifact,
)


def _s3_reference(name: str) -> ArtifactReference:
    return ArtifactReference(
        uri=f"s3://sec-review/{name}",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )


@pytest.mark.asyncio
async def test_extractor_returns_preview_and_records_to_explicit_transcript(
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "review.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    agent_transcript = tmp_path / "extractor.jsonl"

    with (
        patch(
            "sec_review_agents.memory.extractor.create_chat_model",
            return_value=Mock(name="memory-extractor-model"),
        ) as create_model,
        patch(
            "sec_review_agents.memory.extractor.create_memory_extractor_agent_graph",
            AsyncMock(return_value=Mock()),
        ),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            AsyncMock(
                return_value={
                    "has_observation": True,
                    "observation_markdown": "Reuse the verified boundary.",
                }
            ),
        ) as invoke,
    ):
        result = await preview_memory_observation_from_paths(
            [transcript],
            extraction_id_value="extraction-1",
            source_workflow="issue-review",
            run_id="run-1",
            extractor_transcript_path=agent_transcript,
        )

    assert result.extractor_transcript_path == agent_transcript
    assert result.observation_markdown is not None
    assert "Reuse the verified boundary." in result.observation_markdown
    create_model.assert_called_once_with(
        agent_name="memory-extractor",
        deployment_override=None,
    )
    assert invoke.await_args is not None
    assert invoke.await_args.kwargs["transcript_paths"] == (agent_transcript,)


@pytest.mark.asyncio
async def test_extractor_skips_without_transcripts_or_agent_execution(
    tmp_path: Path,
) -> None:
    empty_review = tmp_path / "empty-review"
    empty_review.mkdir()
    create_agent = AsyncMock()
    invoke = AsyncMock()

    with (
        patch(
            "sec_review_agents.memory.extractor.create_memory_extractor_agent_graph",
            create_agent,
        ),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            invoke,
        ),
    ):
        result = await preview_memory_observation_from_paths(
            [empty_review],
            extraction_id_value="Explicit Extraction/1",
            extractor_transcript_path=tmp_path / "extractor.jsonl",
        )

    assert result.extraction_id == "explicit-extraction-1"
    assert result.skipped is True
    assert result.observation_markdown is None
    assert result.extractor_transcript_path is None
    create_agent.assert_not_awaited()
    invoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_extractor_skips_when_agent_produces_no_observation(
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "review.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    agent_transcript = tmp_path / "extractor.jsonl"

    with (
        patch(
            "sec_review_agents.memory.extractor.create_chat_model",
            return_value=Mock(name="memory-extractor-model"),
        ) as create_model,
        patch(
            "sec_review_agents.memory.extractor.create_memory_extractor_agent_graph",
            AsyncMock(return_value=Mock()),
        ),
        patch(
            "sec_review_agents.memory.extractor.invoke_agent_runtime_graph",
            AsyncMock(
                return_value={
                    "has_observation": False,
                    "observation_markdown": "ignored text",
                }
            ),
        ),
    ):
        result = await preview_memory_observation_from_paths(
            [transcript],
            extraction_id_value="extraction-1",
            extractor_transcript_path=agent_transcript,
        )

    assert result.skipped is True
    assert result.observation_markdown is None
    assert result.extractor_transcript_path == agent_transcript
    create_model.assert_called_once_with(
        agent_name="memory-extractor",
        deployment_override=None,
    )


@pytest.mark.asyncio
async def test_maintainer_builds_candidate_tree_from_explicit_inputs(
    tmp_path: Path,
) -> None:
    base_tree = tmp_path / "base"
    (base_tree / "topics").mkdir(parents=True)
    (base_tree / "MEMORY.md").write_text("# Existing\n", encoding="utf-8")
    (base_tree / "topics" / "existing.md").write_text(
        "Existing topic.\n", encoding="utf-8"
    )
    observation = tmp_path / "observation.md"
    observation.write_text("New lesson.\n", encoding="utf-8")
    candidate = tmp_path / "candidate"
    agent_transcript = tmp_path / "maintainer.jsonl"

    async def invoke_agent(**kwargs) -> dict[str, object]:
        worktree = candidate
        assert (worktree / "observations" / "observation-0001.md").read_text(
            encoding="utf-8"
        ) == "New lesson.\n"
        (worktree / "MEMORY.md").write_text("# Updated\n", encoding="utf-8")
        return {}

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_chat_model",
            return_value=Mock(name="memory-maintainer-model"),
        ) as create_model,
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph",
            AsyncMock(return_value=Mock()),
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            AsyncMock(side_effect=invoke_agent),
        ) as invoke,
    ):
        result = await maintain_memory_tree(
            base_memory_tree=base_tree,
            observations=[("extraction-1", observation)],
            worktree_root=candidate,
            maintainer_transcript_path=agent_transcript,
        )

    assert result.memory_tree_path == candidate
    assert result.maintainer_transcript_path == agent_transcript
    assert (candidate / "MEMORY.md").read_text(encoding="utf-8") == "# Updated\n"
    assert (candidate / "topics" / "existing.md").is_file()
    create_model.assert_called_once_with(
        agent_name="memory-maintainer",
        deployment_override=None,
    )
    assert invoke.await_args is not None
    assert invoke.await_args.kwargs["transcript_paths"] == (agent_transcript,)
    assert (
        "/memory/observations/observation-0001.md"
        in invoke.await_args.kwargs["user_prompt"]
    )
    assert (candidate / "observations" / "observation-0001.md").is_file()

    reference = publish_memory_tree_artifact(
        memory_content_root=result.memory_tree_path,
        output_dir=tmp_path / "published",
        remote=False,
    )
    materialized = materialize_memory_tree(
        reference,
        destination=tmp_path / "materialized",
    )

    assert sorted(path.name for path in materialized.iterdir()) == [
        "MEMORY.md",
        "topics",
    ]
    assert not (materialized / "observations").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("base_index", "observations", "expected_exception"),
    [
        (None, [("extraction-1", "lesson")], ValueError),
        ("# Memory\n", [("duplicate", "one"), ("duplicate", "two")], ValueError),
        ("# Memory\n", [("missing", None)], FileNotFoundError),
    ],
)
async def test_maintainer_rejects_invalid_explicit_inputs_before_agent_execution(
    tmp_path: Path,
    base_index: str | None,
    observations: list[tuple[str, str | None]],
    expected_exception: type[Exception],
) -> None:
    base_tree = tmp_path / "base"
    base_tree.mkdir()
    if base_index is not None:
        (base_tree / "MEMORY.md").write_text(base_index, encoding="utf-8")
    inputs: list[tuple[str, Path]] = []
    for index, (extraction_id, body) in enumerate(observations):
        path = tmp_path / f"observation-{index}.md"
        if body is not None:
            path.write_text(body, encoding="utf-8")
        inputs.append((extraction_id, path))
    create_agent = AsyncMock()
    invoke = AsyncMock()

    with (
        patch(
            "sec_review_agents.memory.maintainer.create_memory_maintainer_agent_graph",
            create_agent,
        ),
        patch(
            "sec_review_agents.memory.maintainer.invoke_agent_runtime_graph",
            invoke,
        ),
        pytest.raises(expected_exception),
    ):
        await maintain_memory_tree(
            base_memory_tree=base_tree,
            observations=inputs,
            worktree_root=tmp_path / "candidate",
            maintainer_transcript_path=tmp_path / "maintainer.jsonl",
        )

    create_agent.assert_not_awaited()
    invoke.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("expected_active_revision", "active_reference"),
    [(0, None), (1, _s3_reference("memory-tree").as_dict())],
)
async def test_coordinated_maintenance_accepts_catalog_revision_reference_pairs(
    tmp_path: Path,
    expected_active_revision: int,
    active_reference: dict[str, object] | None,
) -> None:
    client = Mock()
    client.get_maintenance_input.return_value = {
        "expected_active_revision": expected_active_revision,
        "active_memory_tree_reference": active_reference,
        "observations": [
            {"extraction_id": "extraction-1", "body_markdown": "Remember this."}
        ],
    }
    base_tree = tmp_path / "active"
    base_tree.mkdir()
    result = SimpleNamespace(
        memory_tree_path=tmp_path / "candidate",
        maintainer_transcript_path=tmp_path / "maintainer.jsonl",
    )
    memory_reference = _s3_reference("published-memory-tree")
    transcript_reference = _s3_reference("maintainer-transcript")

    with (
        patch(
            "sec_review_agents.memory.coordinated_maintenance.materialize_memory_tree",
            return_value=base_tree,
        ) as materialize,
        patch(
            "sec_review_agents.memory.coordinated_maintenance.maintain_memory_tree",
            AsyncMock(return_value=result),
        ) as maintain,
        patch(
            "sec_review_agents.memory.coordinated_maintenance.publish_memory_agent_transcript",
            return_value=transcript_reference,
        ),
        patch(
            "sec_review_agents.memory.coordinated_maintenance.publish_memory_tree_artifact",
            return_value=memory_reference,
        ),
    ):
        prepared = await prepare_coordinated_memory_revision(
            catalog_client=client,
            maintenance_id="maintenance-1",
            batch_size=10,
        )

    assert prepared is not None
    assert prepared.expected_active_revision == expected_active_revision
    assert prepared.extraction_ids == ("extraction-1",)
    assert maintain.await_args is not None
    assert maintain.await_args.kwargs["base_memory_tree"] == (
        None if active_reference is None else base_tree
    )
    if active_reference is None:
        materialize.assert_not_called()
    else:
        materialize.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("maintenance_input", "message"),
    [
        (
            {
                "expected_active_revision": "0",
                "active_memory_tree_reference": None,
                "observations": [
                    {
                        "extraction_id": "extraction-1",
                        "body_markdown": "Remember this.",
                    }
                ],
            },
            "expected active revision",
        ),
        (
            {
                "expected_active_revision": 0,
                "active_memory_tree_reference": [],
                "observations": [
                    {
                        "extraction_id": "extraction-1",
                        "body_markdown": "Remember this.",
                    }
                ],
            },
            "active memory reference",
        ),
        (
            {
                "expected_active_revision": 0,
                "active_memory_tree_reference": _s3_reference(
                    "unexpected-memory-tree"
                ).as_dict(),
                "observations": [
                    {
                        "extraction_id": "extraction-1",
                        "body_markdown": "Remember this.",
                    }
                ],
            },
            "null exactly at revision 0",
        ),
        (
            {
                "expected_active_revision": 1,
                "active_memory_tree_reference": None,
                "observations": [
                    {
                        "extraction_id": "extraction-1",
                        "body_markdown": "Remember this.",
                    }
                ],
            },
            "null exactly at revision 0",
        ),
        (
            {
                "expected_active_revision": 0,
                "active_memory_tree_reference": None,
                "observations": [
                    {"extraction_id": 1, "body_markdown": "Remember this."}
                ],
            },
            "extraction_id",
        ),
        (
            {
                "expected_active_revision": 0,
                "active_memory_tree_reference": None,
                "observations": [{"extraction_id": "extraction-1", "body_markdown": 1}],
            },
            "body_markdown",
        ),
    ],
)
async def test_coordinated_maintenance_rejects_invalid_catalog_payloads(
    maintenance_input: dict[str, object],
    message: str,
) -> None:
    client = Mock()
    client.get_maintenance_input.return_value = maintenance_input

    with pytest.raises(ValueError, match=message):
        await prepare_coordinated_memory_revision(
            catalog_client=client,
            maintenance_id="maintenance-1",
            batch_size=10,
        )
