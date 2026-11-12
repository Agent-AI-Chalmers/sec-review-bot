from pathlib import Path

from sec_review_agents.resources.loader import load_prompt_resource

MEMORY_EXTRACTOR_SYSTEM_PROMPT = load_prompt_resource("memory/extract-system.md")

MEMORY_EXTRACTION_INPUTS_INTRO = "\n".join(
    [
        "### Trajectory Inputs",
        "",
        (
            "The staged append-only JSONL review trajectories are readable only "
            "through `list_trajectory_messages` and `read_trajectory_message`. "
            "Their `/trajectories/...` paths are identifiers for those tools, "
            "not files in the filesystem: `ls`, `glob`, and `read_file` cannot "
            "see them."
        ),
        "",
        "Read these trajectories in order:",
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
