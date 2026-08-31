from sec_review_agents.resources.loader import (
    join_prompt_sections,
    load_prompt_resource,
)

PATCH_SYNTHESIS_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Synthesize one coherent security patch by editing the repository workspace directly.",
    ]
)


def build_patch_synthesis_system_prompt() -> str:
    return join_prompt_sections(
        [
            "patch-synthesis/system.md",
            "shared/workspace-evidence-rule.md",
        ]
    )


def build_patch_synthesis_filesystem_system_prompt() -> str:
    return load_prompt_resource("patch-synthesis/filesystem-system.md")


def build_patch_synthesis_user_prompt(
    patch_synthesis_brief: str,
) -> str:
    return "\n".join(
        [
            PATCH_SYNTHESIS_INTRO,
            "",
            patch_synthesis_brief,
        ]
    )
