#!/usr/bin/env python3
# Experimental script. It may be incomplete, may not track the latest package
# APIs, and may not fit current run artifacts. Review and adapt this script for
# your own inputs and risk tolerance before use.

import argparse
import asyncio
import tempfile
from pathlib import Path

from sec_review_agents.agents.memory_extractor.agent import (
    MEMORY_EXTRACTOR_AGENT_NAME,
    create_memory_extractor_agent_graph,
)
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
    build_extractor_prompt,
)
from sec_review_agents.filesystem.backend_factory import create_backend_with_materials
from sec_review_agents.filesystem.material_views import read_only_material_view
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.extractor import (
    _group_transcript_refs_by_thread,
    _observation_header,
    _observation_id_for_transcripts,
    collect_transcript_refs,
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
        help=(
            "Optional base observation id. Multi-thread inputs append the thread "
            "slug."
        ),
    )
    parser.add_argument(
        "--source-workflow",
        default="experimental-local-preview",
        help="Provenance label written into observation headers.",
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help="Optional provenance run id and id component.",
    )
    return parser.parse_args()


def _write_observation(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


async def main() -> int:
    bootstrap_agents_env()
    args = _parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    transcript_refs = collect_transcript_refs(args.inputs)
    if not transcript_refs:
        print("No transcript files found.")
        return 1

    groups = _group_transcript_refs_by_thread(transcript_refs)
    written: list[Path] = []
    skipped = 0

    for group in groups:
        observation_id_value = _observation_id_for_transcripts(
            group,
            all_thread_count=len(groups),
            explicit_observation_id=args.observation_id,
            source_workflow=args.source_workflow,
            run_id=args.run_id,
        )
        with tempfile.TemporaryDirectory(
            prefix="sec-review-memory-observation-preview-"
        ) as tempdir:
            temp_root = Path(tempdir)
            transcript_root = temp_root / "transcripts"
            staged = stage_transcripts(group, transcript_root)
            backend = create_backend_with_materials(
                container_name_prefix="memory-observation-preview",
                material_views=[
                    read_only_material_view(
                        agent_path="/transcripts",
                        host_path=transcript_root,
                    )
                ],
                use_docker_sandbox=False,
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

        observation_body = str(
            structured_result.get("observation_markdown") or ""
        ).strip()
        if not structured_result.get("has_observation") or not observation_body:
            skipped += 1
            print(f"Skipped {group[0].thread}: no durable observation.")
            continue

        artifact_root = None
        input_dirs = [path for path in args.inputs if path.expanduser().is_dir()]
        if len(input_dirs) == 1:
            artifact_root = input_dirs[0]
        content = (
            _observation_header(
                observation_id_value=observation_id_value,
                source_workflow=args.source_workflow,
                run_id=args.run_id,
                artifact_root_path=artifact_root,
                staged_transcripts=staged,
            )
            + observation_body.rstrip()
            + "\n"
        )
        target = output_dir / f"{observation_id_value}.md"
        _write_observation(target, content)
        written.append(target)
        print(f"Wrote {target}")

    if not written:
        print(f"No observations written. Threads skipped: {skipped}.")
        return 1
    print(f"Observations written: {len(written)}; threads skipped: {skipped}.")
    print(WARNING)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
