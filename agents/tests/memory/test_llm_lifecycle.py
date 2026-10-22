import json
from pathlib import Path
from uuid import uuid4

import pytest

from sec_review_agents.memory.extractor import extract_memory_observations_from_paths
from sec_review_agents.memory.maintainer import maintain_memory_with_result
from sec_review_agents.memory.state import open_memory_state
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_content_dir,
    memory_observations_dir,
)
from tests.llm_probe import llm_probe, llm_test_deployment

pytestmark = [pytest.mark.integration, pytest.mark.llm]

LIFECYCLE_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_LIFECYCLE_INTEGRATION",
    description="real LLM memory lifecycle extraction + maintenance probe",
)


def _write_transcript(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for seq, record in enumerate(records, start=1):
        message = {
            "type": record["type"],
            "id": f"fixture-message-{seq}",
            "name": None,
            "content": record["content"],
            "additional_kwargs": {},
            "response_metadata": {},
            "tool_calls": [],
            "invalid_tool_calls": [],
            "tool_call_chunks": [],
            "usage_metadata": None,
        }
        lines.append(
            json.dumps(
                {"seq": seq, "event": "message", "message": message},
                separators=(",", ":"),
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fetch_observation_status(memory_root: Path, observation_id: str) -> str | None:
    with open_memory_state(memory_root) as connection:
        row = connection.execute(
            "select status from observations where observation_id = ?",
            (observation_id,),
        ).fetchone()
    return None if row is None else str(row[0])


@pytest.mark.skipif(
    not LIFECYCLE_PROBE.enabled(),
    reason=LIFECYCLE_PROBE.skip_reason(),
)
@pytest.mark.asyncio
async def test_llm_extracts_and_maintains_memory_from_review_transcripts() -> None:
    root = Path(".agent-artifacts") / "memory-probes" / f"lifecycle-{uuid4().hex[:8]}"
    artifacts = root / "artifacts"
    transcript_root = artifacts / "transcripts"
    memory_root = initialize_memory_store(root / "memory")

    _write_transcript(
        transcript_root / "0001-analyzer-initial.jsonl",
        [
            {
                "type": "system",
                "content": (
                    "Analyze repository evidence and keep confidence calibrated "
                    "to verified source-to-sink facts."
                ),
            },
            {
                "type": "ai",
                "content": (
                    "Analyzer result: high confidence. I believe the uploaded "
                    "filename reaches the archive extraction sink."
                ),
            },
        ],
    )
    _write_transcript(
        transcript_root / "0002-mitigator-initial.jsonl",
        [
            {
                "type": "ai",
                "content": (
                    "Mitigator draft: normalize archive paths before writing "
                    "files, based on the analyzer's source-to-sink claim."
                ),
            }
        ],
    )
    _write_transcript(
        transcript_root / "0003-verifier-initial.jsonl",
        [
            {
                "type": "ai",
                "content": (
                    "Verifier result: the analyzer's key source-to-sink "
                    "assumption is unsupported. The extracted archive path is "
                    "already canonicalized before the sink. Reusable lesson: "
                    "when verifier evidence contradicts analyzer confidence, "
                    "demote confidence and re-check the chain before using the "
                    "finding to plan mitigation."
                ),
            }
        ],
    )

    extraction = await extract_memory_observations_from_paths(
        [artifacts],
        memory_store_dir=memory_root,
        deployment=llm_test_deployment(),
        job_id="llm-memory-lifecycle-probe-run-1",
        source_workflow="llm-memory-lifecycle-probe",
        run_id="run-1",
    )
    maintenance = await maintain_memory_with_result(
        memory_store_dir=memory_root,
        deployment=llm_test_deployment(),
    )

    runtime_memory_root = memory_content_dir(memory_root)
    observation_files = sorted(memory_observations_dir(memory_root).glob("*.md"))
    extractor_transcripts = sorted(
        (memory_root / "agent-transcripts" / "memory-extractor").glob("*.jsonl")
    )
    maintainer_transcripts = sorted(
        (memory_root / "agent-transcripts" / "memory-maintainer").glob("*.jsonl")
    )
    memory_index = (runtime_memory_root / "MEMORY.md").read_text(encoding="utf-8")
    topic_files = sorted((runtime_memory_root / "topics").glob("*.md"))
    topic_text = "\n\n".join(
        f"## {path.relative_to(runtime_memory_root)}\n"
        + path.read_text(encoding="utf-8")
        for path in topic_files
    )
    observation_text = (
        extraction.observation_path.read_text(encoding="utf-8")
        if extraction.observation_path is not None
        else ""
    )

    print(
        "\n".join(
            [
                "memory lifecycle probe:",
                f"- artifact root: {root.resolve()}",
                f"- extraction summary: {extraction.summary}",
                f"- maintenance summary: {maintenance.summary}",
                f"- observation path: {extraction.observation_path}",
                f"- observation files: {[str(path.relative_to(memory_root)) for path in observation_files]}",
                f"- extractor transcripts: {[str(path.relative_to(memory_root)) for path in extractor_transcripts]}",
                f"- maintainer transcripts: {[str(path.relative_to(memory_root)) for path in maintainer_transcripts]}",
                f"- topic files: {[str(path.relative_to(runtime_memory_root)) for path in topic_files]}",
                "",
                "observation:",
                observation_text,
                "",
                "MEMORY.md:",
                memory_index,
                "",
                "topics:",
                topic_text,
            ]
        )
    )

    assert not extraction.skipped
    assert extraction.observation_path is not None
    assert maintenance.processed_count == 1
    assert len(extractor_transcripts) == 1
    assert len(maintainer_transcripts) == 1
    assert (
        _fetch_observation_status(memory_root, "llm-memory-lifecycle-probe-run-1")
        == "processed"
    )
    combined_memory = f"{memory_index}\n{topic_text}".lower()
    assert "verifier" in combined_memory
    assert "confidence" in combined_memory
    assert "source-to-sink" in combined_memory
