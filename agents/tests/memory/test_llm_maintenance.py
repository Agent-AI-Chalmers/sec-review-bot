from pathlib import Path
from uuid import uuid4

import pytest

from sec_review_agents.memory.maintainer import maintain_memory_tree
from tests.llm_probe import llm_probe, llm_test_deployment

pytestmark = [pytest.mark.integration, pytest.mark.llm]

MAINTENANCE_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION",
    description="real LLM memory maintenance probe",
)


@pytest.mark.skipif(
    not MAINTENANCE_PROBE.enabled(),
    reason=MAINTENANCE_PROBE.skip_reason(),
)
@pytest.mark.asyncio
async def test_llm_maintenance_reorganizes_messy_memory_without_trajectories() -> None:
    root = Path(".agent-artifacts") / "memory-probes" / f"maintenance-{uuid4().hex[:8]}"
    runtime_memory_root = root / "base-memory"
    topics_root = runtime_memory_root / "topics"
    topics_root.mkdir(parents=True)
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

    observation = root / "maintenance-probe.md"
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
    result = await maintain_memory_tree(
        base_memory_tree=runtime_memory_root,
        observations=[("maintenance-probe", observation)],
        worktree_root=root / "candidate-memory",
        maintainer_trajectory_path=root / "memory-maintainer.jsonl",
        deployment=llm_test_deployment(),
    )

    candidate = result.memory_tree_path
    memory_index = (candidate / "MEMORY.md").read_text(encoding="utf-8")
    topic_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((candidate / "topics").glob("*.md"))
    )
    print(
        "\n".join(
            [
                "memory maintenance probe:",
                f"- artifact root: {root.resolve()}",
                f"- memory files: {[str(path.relative_to(candidate)) for path in sorted(candidate.rglob('*.md'))]}",
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
    assert not (candidate / "topics" / "retry-confidence.md").exists()
    assert "source-to-sink" in topic_text.lower()
    assert "confidence" in topic_text.lower()
    assert observation.exists()
