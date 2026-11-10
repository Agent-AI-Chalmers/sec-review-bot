from sec_review_agents.resources.loader import load_prompt_resource

MEMORY_MAINTAINER_SYSTEM_PROMPT = load_prompt_resource("memory/maintain-system.md")


def build_maintenance_prompt(
    observations: list[tuple[str, str]],
    *,
    reorganization: bool = False,
) -> str:
    if reorganization:
        if observations:
            raise ValueError(
                "Memory reorganization must not receive selected observations."
            )
        return "\n".join(
            [
                "### Selected Observations",
                "",
                "None. No observations were selected for this reorganization pass.",
                "",
                "### Task",
                "",
                (
                    "Maintain `/memory/MEMORY.md` and `/memory/topics/*.md` using only "
                    "the current memory."
                ),
                "",
                (
                    "You may merge, split, delete, rename, compress, rewrite, or "
                    "cross-reference topic files. Do not add security-review facts or "
                    "rules that are not already present in the current memory."
                ),
                "",
                (
                    "If the memory is already clear and needs no reorganization, leave it "
                    "unchanged."
                ),
            ]
        )
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
                "durable material, leave memory unchanged."
            ),
        ]
    )
