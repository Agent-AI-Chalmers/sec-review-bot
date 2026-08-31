from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from sec_review_agents.memory.maintainer import maintain_memory_with_result
from sec_review_agents.memory.state import (
    OBSERVATION_STATUS_PENDING,
    open_memory_state,
    upsert_observation,
)
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_content_dir,
    memory_observations_dir,
)
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import llm_probe

MAINTENANCE_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION",
    description="real LLM memory maintenance probe",
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


@pytest.mark.skipif(
    not MAINTENANCE_PROBE.enabled(),
    reason=MAINTENANCE_PROBE.skip_reason(),
)
@pytest.mark.asyncio
async def test_llm_maintenance_reorganizes_messy_memory_without_transcripts() -> None:
    root = Path(".agent-artifacts") / "memory-probes" / f"maintenance-{uuid4().hex[:8]}"
    memory_root = initialize_memory_store(root / "memory")
    runtime_memory_root = memory_content_dir(memory_root)
    topics_root = runtime_memory_root / "topics"
    (runtime_memory_root / "MEMORY.md").write_text(
        "\n".join(
            [
                "# Security Review Experience Memory",
                "",
                "This index has grown into a notebook.",
                "",
                "Detailed lesson that should not live in the index:",
                "When verifier evidence contradicts analyzer confidence, late verifier correction should lower confidence until the source-to-sink chain is checked again.",
                "",
                "Another detailed duplicate: verifier contradiction means analyzer certainty should be demoted before remediation planning.",
                "",
                "## Topics",
                "",
                "- `topics/verifier-confidence.md` - Verifier confidence notes, but the index still contains the details above.",
                "- `topics/retry-confidence.md` - Duplicate retry confidence notes.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (topics_root / "verifier-confidence.md").write_text(
        "\n".join(
            [
                "# Verifier Confidence",
                "",
                "If verifier evidence contradicts analyzer confidence, lower confidence until the source-to-sink chain is checked again.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (topics_root / "retry-confidence.md").write_text(
        "\n".join(
            [
                "# Retry Confidence",
                "",
                "Duplicate: verifier contradiction means analyzer certainty should be demoted before remediation planning.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    observation = memory_observations_dir(memory_root) / "maintenance-probe.md"
    observation.write_text(
        "\n".join(
            [
                "# Observation",
                "",
                "Reusable lesson: verifier evidence should lower analyzer confidence when they conflict.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    with open_memory_state(memory_root) as connection:
        upsert_observation(
            connection,
            observation_id="maintenance-probe",
            path=str(observation),
            status=OBSERVATION_STATUS_PENDING,
        )

    with patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "local"}):
        result = await maintain_memory_with_result(
            memory_store_dir=memory_root,
            deployment=llm_test_deployment(),
        )

    memory_index = (runtime_memory_root / "MEMORY.md").read_text(encoding="utf-8")
    topic_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((runtime_memory_root / "topics").glob("*.md"))
    )
    print(
        "\n".join(
            [
                "memory maintenance probe:",
                f"- artifact root: {root.resolve()}",
                f"- summary: {result.summary}",
                f"- memory files: {[str(path.relative_to(memory_root)) for path in sorted(memory_root.rglob('*.md'))]}",
                f"- MEMORY.md chars: {len(memory_index)}",
                "",
                "MEMORY.md:",
                memory_index,
                "",
                "topics:",
                topic_text,
            ]
        )
    )

    assert "topics/" in memory_index
    assert len(memory_index) < 450
    assert "grown into a notebook" not in memory_index
    assert not (topics_root / "retry-confidence.md").exists()
    assert "source-to-sink" in topic_text.lower()
    assert "confidence" in topic_text.lower()
    assert observation.exists()
    with open_memory_state(memory_root) as connection:
        rows = _fetch_observations_by_ids(connection, ["maintenance-probe"])
    assert rows[0].status == "processed"
