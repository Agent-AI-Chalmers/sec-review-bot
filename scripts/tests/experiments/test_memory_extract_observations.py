import argparse
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from scripts.experiments import memory_extract_observations as script
from sec_review_agents.memory.extractor import MemoryObservationPreviewResult


@pytest.mark.asyncio
@pytest.mark.parametrize("bodies", [[], ["Lesson A."], ["Lesson A.", "Lesson B."]])
async def test_preview_writes_each_lesson_and_empty_extraction_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bodies: list[str]
) -> None:
    output = tmp_path / "output"
    args = argparse.Namespace(
        output_dir=output,
        extraction_id="run-1",
        job_id=None,
        source_workflow="preview",
        run_id="run",
        inputs=[],
        deployment=None,
    )
    monkeypatch.setattr(script, "bootstrap_agents_env", lambda: None)
    monkeypatch.setattr(script, "_parse_args", lambda: args)
    monkeypatch.setattr(
        script,
        "preview_memory_observation_from_paths",
        AsyncMock(
            return_value=MemoryObservationPreviewResult(
                extraction_id="run-1",
                skipped=not bodies,
                summary="Extracted.",
                observations=bodies,
                extractor_trajectory_path=output / "extractor.jsonl",
            )
        ),
    )
    assert await script.main() == 0
    assert [p.read_text() for p in sorted(output.glob("*.md"))] == [
        body + "\n" for body in bodies
    ]
    # Reusing the directory must fail so old lessons cannot survive a shorter rerun.
    with pytest.raises(FileExistsError):
        await script.main()


@pytest.mark.asyncio
async def test_missing_trajectories_are_not_a_successful_empty_extraction(
    tmp_path, monkeypatch
):
    (tmp_path / "missing").mkdir()
    args = argparse.Namespace(
        output_dir=tmp_path / "output",
        extraction_id="missing",
        job_id=None,
        source_workflow="preview",
        run_id=None,
        inputs=[tmp_path / "missing"],
        deployment=None,
    )
    monkeypatch.setattr(script, "bootstrap_agents_env", lambda: None)
    monkeypatch.setattr(script, "_parse_args", lambda: args)
    with pytest.raises(ValueError, match="No review trajectories"):
        await script.main()
