import json
from argparse import Namespace
from unittest.mock import AsyncMock

import pytest
from scripts.experiments import memory_maintain


def _args(tmp_path):
    observation = tmp_path / "task-01.md"
    observation.write_text("Experience\n")
    return Namespace(
        inputs=[observation],
        base_memory=None,
        output_dir=tmp_path / "run",
        deployment="test",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("with_base", [False, True])
async def test_build_preserves_inputs_and_excludes_staged_observations(
    tmp_path, monkeypatch, with_base
):
    args = _args(tmp_path)
    if with_base:
        args.base_memory = tmp_path / "base"
        args.base_memory.mkdir()
        (args.base_memory / "MEMORY.md").write_text("Original\n")

    async def maintain(**kwargs):
        assert kwargs["base_memory_tree"] == args.base_memory
        assert kwargs["observations"] == [("task-01", args.inputs[0])]
        tree = kwargs["worktree_root"]
        (tree / "observations").mkdir(parents=True)
        (tree / "observations" / "input.md").write_text("Experience\n")
        (tree / "MEMORY.md").write_text("Maintained\n")
        kwargs["maintainer_trajectory_path"].write_text("trajectory\n")

    monkeypatch.setattr(memory_maintain, "maintain_memory_tree", maintain)
    tree = await memory_maintain.run(args)
    assert (tree / "MEMORY.md").read_text() == "Maintained\n"
    assert not (tree / "observations").exists()
    assert args.inputs[0].read_text() == "Experience\n"
    if with_base:
        assert (args.base_memory / "MEMORY.md").read_text() == "Original\n"
    manifest = json.loads((args.output_dir / "manifest.json").read_text())
    assert manifest["status"] == "completed"
    assert manifest["observations"][0]["id"] == "task-01"
    assert manifest["memory_files"][0]["path"] == "MEMORY.md"


@pytest.mark.asyncio
async def test_reorganization_uses_base_memory_and_no_observations(
    tmp_path, monkeypatch
):
    base = tmp_path / "base"
    (base / "topics").mkdir(parents=True)
    (base / "MEMORY.md").write_text("Existing\n")
    (base / "topics" / "topic.md").write_text("Topic\n")
    args = Namespace(
        inputs=[],
        base_memory=base,
        output_dir=tmp_path / "run",
        deployment="test",
        mode="reorganization",
    )

    async def maintain(**kwargs):
        assert kwargs["base_memory_tree"] == base
        assert kwargs["observations"] == []
        assert kwargs["reorganization"] is True
        tree = kwargs["worktree_root"]
        (tree / "observations").mkdir(parents=True)
        (tree / "MEMORY.md").write_text("Reorganized\n")
        kwargs["maintainer_trajectory_path"].write_text("trajectory\n")

    monkeypatch.setattr(memory_maintain, "maintain_memory_tree", maintain)
    tree = await memory_maintain.run(args)
    assert (tree / "MEMORY.md").read_text() == "Reorganized\n"
    manifest = json.loads((args.output_dir / "manifest.json").read_text())
    assert manifest["mode"] == "reorganization"
    assert manifest["observations"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["with_input", "without_base"])
async def test_invalid_reorganization_inputs_do_not_call_model(
    tmp_path, monkeypatch, invalid
):
    args = Namespace(
        inputs=[],
        base_memory=None,
        output_dir=tmp_path / "run",
        deployment="test",
        mode="reorganization",
    )
    if invalid == "with_input":
        observation = tmp_path / "task.md"
        observation.write_text("Experience\n")
        args.inputs = [observation]
    maintain = AsyncMock()
    monkeypatch.setattr(memory_maintain, "maintain_memory_tree", maintain)
    with pytest.raises(ValueError):
        await memory_maintain.run(args)
    maintain.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["existing", "duplicate", "missing_base"])
async def test_invalid_inputs_do_not_call_model(tmp_path, monkeypatch, invalid):
    args = _args(tmp_path)
    if invalid == "existing":
        args.output_dir.mkdir()
    elif invalid == "duplicate":
        args.inputs *= 2
    else:
        args.base_memory = tmp_path / "absent"
    maintain = AsyncMock()
    monkeypatch.setattr(memory_maintain, "maintain_memory_tree", maintain)
    with pytest.raises((ValueError, FileExistsError)):
        await memory_maintain.run(args)
    maintain.assert_not_awaited()


@pytest.mark.asyncio
async def test_failure_preserves_partial_work_and_records_failure(
    tmp_path, monkeypatch
):
    args = _args(tmp_path)

    async def fail(**kwargs):
        kwargs["worktree_root"].mkdir()
        (kwargs["worktree_root"] / "partial.md").write_text("Partial\n")
        kwargs["maintainer_trajectory_path"].write_text("Partial trajectory\n")
        raise RuntimeError("Model interrupted")

    monkeypatch.setattr(memory_maintain, "maintain_memory_tree", fail)
    with pytest.raises(RuntimeError, match="Model interrupted"):
        await memory_maintain.run(args)
    assert (args.output_dir / "memory" / "partial.md").exists()
    assert len(list(args.output_dir.glob("maintainer*.jsonl"))) == 1
    assert (
        json.loads((args.output_dir / "manifest.json").read_text())["status"]
        == "failed"
    )
