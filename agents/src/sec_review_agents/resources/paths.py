from importlib.resources import files

AGENT_RESOURCES = files("sec_review_agents.resources")
AGENT_PROMPTS = AGENT_RESOURCES / "prompts"
AGENT_SKILLS = AGENT_RESOURCES / "skills"
