from sec_review_agents.resources.paths import AGENT_PROMPTS


def load_prompt_resource(relative_path: str) -> str:
    # Prompt files are sections, not serialized payloads; normalize only their
    # trailing line breaks so callers do not need inconsistent local stripping.
    return (AGENT_PROMPTS / relative_path).read_text(encoding="utf-8").rstrip("\n")


def join_prompt_sections(paths: list[str]) -> str:
    return "\n\n".join(load_prompt_resource(path) for path in paths)
