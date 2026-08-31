import json
from pathlib import Path
from unittest.mock import patch
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
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import llm_probe

LIFECYCLE_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_LIFECYCLE_INTEGRATION",
    description="real LLM memory lifecycle extraction + maintenance probe",
)


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(record, separators=(",", ":")) for record in records)
        + "\n",
        encoding="utf-8",
    )


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
    transcript_root = artifacts / "transcripts" / "0001-review"
    memory_root = initialize_memory_store(root / "memory")

    _write_jsonl(
        transcript_root / "0001-analyzer-initial.jsonl",
        [
            {
                "seq": 1,
                "event": "prompt_snapshot",
                "system_prompt": (
                    "Analyze repository evidence and keep confidence calibrated "
                    "to verified source-to-sink facts."
                ),
            },
            {
                "seq": 2,
                "event": "message",
                "message": {
                    "type": "ai",
                    "content": (
                        "Analyzer result: high confidence. I believe the uploaded "
                        "filename reaches the archive extraction sink."
                    ),
                },
            },
        ],
    )
    _write_jsonl(
        transcript_root / "0002-mitigator-initial.jsonl",
        [
            {
                "seq": 1,
                "event": "message",
                "message": {
                    "type": "ai",
                    "content": (
                        "Mitigator draft: normalize archive paths before writing "
                        "files, based on the analyzer's source-to-sink claim."
                    ),
                },
            }
        ],
    )
    _write_jsonl(
        transcript_root / "0003-verifier-initial.jsonl",
        [
            {
                "seq": 1,
                "event": "message",
                "message": {
                    "type": "ai",
                    "content": (
                        "Verifier result: the analyzer's key source-to-sink "
                        "assumption is unsupported. The extracted archive path is "
                        "already canonicalized before the sink. Reusable lesson: "
                        "when verifier evidence contradicts analyzer confidence, "
                        "demote confidence and re-check the chain before using the "
                        "finding to plan mitigation."
                    ),
                },
            }
        ],
    )

    with patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "local"}):
        extraction = await extract_memory_observations_from_paths(
            [artifacts],
            memory_store_dir=memory_root,
            deployment=llm_test_deployment(),
            source_workflow="llm-memory-lifecycle-probe",
            run_id="run-1",
            artifact_root_path=artifacts,
        )
        maintenance = await maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment=llm_test_deployment(),
        )

    runtime_memory_root = memory_content_dir(memory_root)
    observation_files = sorted(memory_observations_dir(memory_root).glob("*.md"))
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
    assert (
        _fetch_observation_status(memory_root, "llm-memory-lifecycle-probe-run-1")
        == "processed"
    )
    combined_memory = f"{memory_index}\n{topic_text}".lower()
    assert "verifier" in combined_memory
    assert "confidence" in combined_memory
    assert "source-to-sink" in combined_memory
