"""Project-owned declarations for external CLIs exposed through the sandbox."""

AGENT_JOERN_ENABLED_ENV = "AGENT_JOERN_ENABLED"
AGENT_PLAYWRIGHT_ENABLED_ENV = "AGENT_PLAYWRIGHT_ENABLED"

EXTERNAL_TOOL_PROMPT_PATHS = {
    "joern": (AGENT_JOERN_ENABLED_ENV, "external-tools/joern.md"),
    "playwright": (AGENT_PLAYWRIGHT_ENABLED_ENV, "external-tools/playwright.md"),
}

__all__ = [
    "AGENT_JOERN_ENABLED_ENV",
    "AGENT_PLAYWRIGHT_ENABLED_ENV",
    "EXTERNAL_TOOL_PROMPT_PATHS",
]
