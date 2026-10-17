#!/usr/bin/env python3
# Experimental script. It may be incomplete, may not track the latest package
# APIs, and may not fit current run artifacts. Review and adapt this script for
# your own inputs and risk tolerance before use.

"""Preview memory observation extraction without modifying a memory store."""

import argparse
import asyncio
import tempfile
from pathlib import Path

from sec_review_agents.agents.memory_extractor.agent import (
    MEMORY_EXTRACTOR_AGENT_NAME,
    create_memory_extractor_agent_graph,
)
from sec_review_agents.agents.memory_extractor.backend import (
    create_memory_extractor_backend,
)
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
    build_extractor_prompt,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.extractor import (
    build_observation_document,
    collect_transcript_refs,
    resolve_observation_id,
    stage_transcripts,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.utils.env import bootstrap_agents_env

WARNING = (
    "Experimental local script. This is not an operational memory ingestion path. "
    "It does not use Temporal, does not write the memory DB, and does not validate "
    "that inputs came from a real review. It may not track the latest package "
    "APIs. Review and adapt the script before use; inspect outputs manually."
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Experimentally read review transcripts and write observation Markdown "
            "files to an output directory. " + WARNING
        )
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        type=Path,
        help=(
            "Review artifact directories containing transcripts/, or transcript "
            "JSON transcript files."
        ),
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Directory where observation Markdown files will be written.",
    )
    parser.add_argument(
        "--deployment",
        default=None,
        help="Optional LLM deployment override for the memory-extractor agent.",
    )
    parser.add_argument(
        "--observation-id",
        default=None,
        help="Optional observation id for the collected transcript sequence.",
    )
    parser.add_argument(
        "--source-workflow",
        default="experimental-local-preview",
        help="Provenance label written into observation headers.",
    )
    parser.add_argument(
        "--job-id",
        default=None,
        help=(
            "Optional extraction job id used to derive the observation id. "
            "Without it, the id is derived from transcript paths."
        ),
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help="Optional provenance run id written into the observation header.",
    )
    return parser.parse_args()


def _write_observation(path: Path, content: str) -> None:
    """Write one normalized observation document to the requested preview path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


async def main() -> int:
    """Run one local extraction attempt over the supplied transcript sequence."""
    bootstrap_agents_env()
    args = _parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    transcript_refs = collect_transcript_refs(args.inputs)
    if not transcript_refs:
        print("No transcript files found.")
        return 1

    observation_id_value = resolve_observation_id(
        transcript_refs,
        explicit_observation_id=args.observation_id,
        job_id=args.job_id,
    )
    with tempfile.TemporaryDirectory(
        prefix="sec-review-memory-observation-preview-"
    ) as tempdir:
        temp_root = Path(tempdir)
        transcript_root = temp_root / "transcripts"
        staged = stage_transcripts(transcript_refs, transcript_root)
        backend = create_memory_extractor_backend(
            transcript_root=transcript_root,
        )
        model = create_chat_model(
            agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
            deployment_override=args.deployment,
        )
        async with amanaged_backend(backend):
            agent = await create_memory_extractor_agent_graph(
                model=model,
                backend=backend,
            )
            structured_result = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
                system_prompt=MEMORY_EXTRACTOR_SYSTEM_PROMPT,
                user_prompt=build_extractor_prompt(staged),
            )

    observation_body = str(structured_result.get("observation_markdown") or "").strip()
    if not structured_result.get("has_observation") or not observation_body:
        print("No observation written: no durable observation.")
        return 1

    content = build_observation_document(
        observation_id_value=observation_id_value,
        source_workflow=args.source_workflow,
        run_id=args.run_id,
        staged_transcripts=staged,
        observation_markdown=observation_body,
    )
    target = output_dir / f"{observation_id_value}.md"
    _write_observation(target, content)
    print(f"Wrote {target}")
    print(WARNING)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
