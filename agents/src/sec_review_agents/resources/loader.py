from sec_review_agents.resources.paths import AGENT_PROMPTS


def load_prompt_resource(relative_path: str) -> str:
    return (AGENT_PROMPTS / relative_path).read_text(encoding="utf-8")


def join_prompt_sections(paths: list[str]) -> str:
    return "\n\n".join(load_prompt_resource(path) for path in paths)
