from pathlib import Path

from sec_review_agents.resources.loader import load_prompt_resource

MEMORY_EXTRACTOR_SYSTEM_PROMPT = load_prompt_resource("memory/extract-system.md")

MEMORY_EXTRACTION_INPUTS_INTRO = "\n".join(
    [
        "### Trajectory Inputs",
        "",
        (
            "The staged append-only JSONL review trajectories are mounted at "
            "`/trajectories`."
        ),
        "",
        "Read these trajectory files in order:",
    ]
)

MEMORY_EXTRACTION_TASK = "\n".join(
    [
        "### Task",
        "",
        (
            "Inspect the listed trajectories. If they contain durable reusable "
            "security-review experience, return one short Markdown observation."
        ),
        "",
        "If there is no durable observation, return no observation.",
    ]
)


def build_extractor_prompt(staged_trajectories: list[tuple[str, Path]]) -> str:
    """Build the ordered trajectory-reading task for one extraction attempt."""
    trajectory_lines = [
        f"- {label}: `{mounted}`" for label, mounted in staged_trajectories
    ]
    return "\n".join(
        [
            MEMORY_EXTRACTION_INPUTS_INTRO,
            "",
            "\n".join(trajectory_lines),
            "",
            MEMORY_EXTRACTION_TASK,
        ]
    )
