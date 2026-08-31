from sec_review_agents.utils.env import env_value, parse_bool_env

AGENT_SKILLS_ENABLED_ENV = "AGENT_SKILLS_ENABLED"
AGENT_MCP_ENABLED_ENV = "AGENT_MCP_ENABLED"
AGENT_MEMORY_ENABLED_ENV = "AGENT_MEMORY_ENABLED"


def agent_skills_enabled() -> bool:
    return parse_bool_env(env_value(AGENT_SKILLS_ENABLED_ENV), True)


def agent_mcp_enabled() -> bool:
    return parse_bool_env(env_value(AGENT_MCP_ENABLED_ENV), True)


def agent_memory_enabled() -> bool:
    return parse_bool_env(env_value(AGENT_MEMORY_ENABLED_ENV), True)
