# Strategy choice (investigated 2026-11-13):
# ProviderStrategy uses the provider's native structured-output API. LangChain
# recommends it when available because the provider enforces supported schema
# constraints. That does not enforce arbitrary Python validators or inspect local
# workbench state: {"done": true} can fit the schema while work remains unfinished.
#
# In the LangChain implementation investigated here, ProviderStrategy raises on
# local output-validation failure; ToolStrategy can feed the error back to the
# model and continue the same agent invocation, including ordinary tool use.
# The shared runtime explicitly chooses ToolStrategy for schema-bearing agents.
# Its automatic corrections have no dedicated attempt limit, so this helper adds
# one. It returns the original error text; schemas and validators own guidance.
#
# Real-model smoke probes covered triage and delivery workbenches with the current
# Anthropic-compatible DeepSeek deployment and GPT deployment. ToolStrategy could
# recover from premature completion by editing the workbench and resubmitting.
# DeepSeek already selected ToolStrategy automatically; GPT selected native output.
# These small synthetic probes establish feasibility, not better overall accuracy,
# cost, or latency. This is a project policy, not a universal strategy ranking.
#
# Similar tradeoffs appear upstream: Apify switched to ToolStrategy after native
# parsing failures aborted runs; LangChain.js users also report ToolStrategy
# protocol failures. Neither strategy is universally more reliable. Recheck the
# dependency's validation and retry behavior when upgrading LangChain.
# Sources:
# https://docs.langchain.com/oss/python/langchain/structured-output
# https://github.com/apify/actor-templates/pull/1073
# https://github.com/langchain-ai/langchain/issues/40753
# https://github.com/langchain-ai/langchainjs/issues/11020

from langchain.agents.structured_output import ToolStrategy
from pydantic import BaseModel

from sec_review_agents.utils.env import int_env


def tool_strategy_with_retry_limit[T: BaseModel](
    schema: type[T], *, max_retries: int | None = None
) -> ToolStrategy[T]:
    """Create a correction budget for one graph invocation; do not reuse across runs.

    Only errors routed through ToolStrategy.handle_errors consume this budget.
    Domain guidance belongs to the schema and its validation errors.
    """
    if max_retries is None:
        max_retries = int_env(
            "AGENT_STRUCTURED_OUTPUT_VALIDATION_MAX_RETRIES", 3, minimum=0
        )
    if max_retries < 0:
        raise ValueError("max_retries must be non-negative")
    retries = 0

    def handle_error(error: Exception) -> str:
        nonlocal retries
        if retries >= max_retries:
            raise RuntimeError(
                f"{schema.__name__} structured output failed after "
                f"{max_retries} correction retries."
            ) from error
        retries += 1
        return str(error)

    return ToolStrategy(schema, handle_errors=handle_error)
