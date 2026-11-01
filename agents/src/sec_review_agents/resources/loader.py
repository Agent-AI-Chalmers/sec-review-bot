from sec_review_agents.resources.paths import AGENT_PROMPTS


def load_prompt_resource(
    relative_path: str, *, workspace_root: str = "/workspace"
) -> str:
    # Only the declared placeholder is substituted. JSON, shell braces and literal
    # paths in examples are not template syntax; never format arbitrary prompt text.
    template = (AGENT_PROMPTS / relative_path).read_text(encoding="utf-8").rstrip("\n")
    return template.replace("{{workspace_root}}", workspace_root)


def join_prompt_sections(
    paths: list[str], *, workspace_root: str = "/workspace"
) -> str:
    return "\n\n".join(
        load_prompt_resource(path, workspace_root=workspace_root) for path in paths
    )
