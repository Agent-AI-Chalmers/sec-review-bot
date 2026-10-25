from sec_review_agents.resources.loader import load_prompt_resource

MEMORY_MAINTAINER_SYSTEM_PROMPT = load_prompt_resource("memory/maintain-system.md")


def build_maintenance_prompt(
    observations: list[tuple[str, str]],
) -> str:
    if not observations:
        raise ValueError("Memory maintenance requires at least one observation.")
    selected = "\n".join(
        f"- `{extraction_id}`: `{mounted_path}`"
        for extraction_id, mounted_path in observations
    )
    return "\n".join(
        [
            "### Selected Observations",
            "",
            selected,
            "",
            "### Task",
            "",
            (
                "Maintain `/memory/MEMORY.md` and `/memory/topics/*.md` using the "
                "current memory and the selected observations."
            ),
            "",
            (
                "If the memory is already clear and the selected observations add no "
                "durable material, leave memory unchanged and say so."
            ),
        ]
    )
