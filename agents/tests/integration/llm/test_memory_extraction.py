import json
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from sec_review_agents.memory.extractor import extract_memory_observations_from_paths
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_content_dir,
    memory_observations_dir,
)
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import llm_probe

EXTRACTION_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_EXTRACTION_INTEGRATION",
    description="real LLM memory extraction probe",
)


@pytest.mark.skipif(
    not EXTRACTION_PROBE.enabled(),
    reason=EXTRACTION_PROBE.skip_reason(),
)
@pytest.mark.asyncio
async def test_llm_extractor_writes_observation_without_updating_memory() -> None:
    root = Path(".agent-artifacts") / "memory-probes" / f"extraction-{uuid4().hex[:8]}"
    artifacts = root / "artifacts"
    analyzer_transcript = (
        artifacts / "transcripts" / "0001-review" / "0001-analyzer-initial.json"
    )
    verifier_transcript = (
        artifacts / "transcripts" / "0001-review" / "0002-verifier-initial.json"
    )
    analyzer_transcript.parent.mkdir(parents=True)
    analyzer_transcript.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "seq": 1,
                        "event": "prompt_snapshot",
                        "system_prompt": (
                            "Analyze repository evidence and keep "
                            "confidence calibrated to verified facts."
                        ),
                    },
                    separators=(",", ":"),
                ),
                json.dumps(
                    {
                        "seq": 2,
                        "event": "message",
                        "message": {
                            "type": "ai",
                            "content": (
                                "Finding confidence: high. The suspected "
                                "source-to-sink chain appears exploitable "
                                "because user input seems to reach the sink."
                            ),
                        },
                    },
                    separators=(",", ":"),
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    verifier_transcript.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "seq": 1,
                        "event": "prompt_snapshot",
                        "system_prompt": (
                            "Verify the analyzer finding against repository evidence."
                        ),
                    },
                    separators=(",", ":"),
                ),
                json.dumps(
                    {
                        "seq": 2,
                        "event": "message",
                        "message": {
                            "type": "ai",
                            "content": (
                                "Verifier result: the key source-to-sink "
                                "assumption is unsupported by the repository "
                                "evidence. Reusable lesson: when verifier "
                                "evidence contradicts analyzer confidence, "
                                "demote confidence and re-check the chain "
                                "before remediation planning."
                            ),
                        },
                    },
                    separators=(",", ":"),
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    memory_root = initialize_memory_store(root / "memory")

    with patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "local"}):
        result = await extract_memory_observations_from_paths(
            [artifacts],
            memory_store_dir=memory_root,
            deployment=llm_test_deployment(),
            source_workflow="llm-memory-extraction-probe",
            run_id="run-1",
            artifact_root_path=artifacts,
        )

    runtime_memory_root = memory_content_dir(memory_root)
    observation_files = sorted(memory_observations_dir(memory_root).glob("*.md"))
    print(
        "\n".join(
            [
                "memory extraction probe:",
                f"- artifact root: {root.resolve()}",
                f"- summary: {result.summary}",
                f"- observation path: {result.observation_path}",
                f"- observation files: {[str(path.relative_to(memory_root)) for path in observation_files]}",
            ]
        )
    )
    assert not result.skipped
    assert result.observation_path is not None
    assert observation_files == [result.observation_path]
    observation_text = result.observation_path.read_text(encoding="utf-8")
    assert "verifier" in observation_text.lower()
    assert "confidence" in observation_text.lower()
    assert (runtime_memory_root / "MEMORY.md").is_file()
    assert (
        "verifier correction"
        not in (runtime_memory_root / "MEMORY.md").read_text(encoding="utf-8").lower()
    )
