"""Allocate local transcript paths for memory-agent invocations."""

from pathlib import Path
from uuid import uuid4

from sec_review_agents.utils.files import slug_filename_component

MEMORY_AGENT_TRANSCRIPTS_DIRNAME = "agent-transcripts"


def memory_agent_transcript_path(
    memory_store_dir: Path,
    *,
    agent_name: str,
    run_label: str,
) -> Path:
    """Allocate one non-overwriting transcript path for a memory-agent run."""
    agent = slug_filename_component(agent_name, fallback="run")
    label = slug_filename_component(run_label, fallback="run")
    root = memory_store_dir / MEMORY_AGENT_TRANSCRIPTS_DIRNAME / agent
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{label}-{uuid4().hex}.jsonl"
