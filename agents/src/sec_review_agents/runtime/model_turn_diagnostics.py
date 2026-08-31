"""LangChain middleware that logs suspicious empty model turns.

This is diagnostic only: it does not retry, raise, or mutate agent state.
"""

from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

from sec_review_agents.observability.diagnostics import log_diagnostic
from sec_review_agents.utils.env import env_value, parse_bool_env

_CONTENT_TEXT_KEYS = ("text", "content", "input", "reasoning", "thinking")


def model_turn_diagnostics_enabled() -> bool:
    return parse_bool_env(
        env_value("AGENT_MODEL_TURN_DIAGNOSTICS"),
        True,
    )


def _content_block_has_substantive_content(item: Any) -> bool:
    # LangChain message content can be a list of provider-specific blocks, e.g.
    # {"type": "text", "text": "..."}; checking str(block) would treat an
    # empty text block as substantive because the dict representation is non-empty.
    if isinstance(item, str):
        return bool(item.strip())

    if isinstance(item, list):
        return any(_content_block_has_substantive_content(value) for value in item)

    if isinstance(item, dict):
        text_values = [item[key] for key in _CONTENT_TEXT_KEYS if key in item]
        if text_values:
            return any(
                _content_block_has_substantive_content(value) for value in text_values
            )
        # Non-text blocks, such as image or file references, still count as a
        # model response when they carry provider-specific payload fields.
        return any(
            _content_block_has_substantive_content(value)
            for key, value in item.items()
            if key != "type"
        )

    return bool(item)


def _has_substantive_content(message: AIMessage) -> bool:
    content = message.content
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(_content_block_has_substantive_content(item) for item in content)
    return bool(content)


def _last_ai_message(messages: list[Any]) -> AIMessage | None:
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            return message
    return None


class ModelTurnDiagnosticsMiddleware(AgentMiddleware):
    def __init__(self, *, agent_name: str) -> None:
        self.agent_name = agent_name

    def after_model(
        self,
        state: AgentState[Any],
        runtime: Runtime[Any],
    ) -> dict[str, Any] | None:
        _ = runtime
        messages = state.get("messages")
        if not isinstance(messages, list) or not messages:
            log_diagnostic(
                "model_turn_diagnostics_warning",
                agent=self.agent_name,
                reason="missing_messages_after_model",
            )
            return None

        last_ai_message = _last_ai_message(messages)
        if last_ai_message is None:
            log_diagnostic(
                "model_turn_diagnostics_warning",
                agent=self.agent_name,
                reason="missing_ai_message_after_model",
            )
            return None

        has_text = _has_substantive_content(last_ai_message)
        has_tool_calls = bool(getattr(last_ai_message, "tool_calls", None))
        has_invalid_tool_calls = bool(
            getattr(last_ai_message, "invalid_tool_calls", None)
        )

        if has_text or has_tool_calls or has_invalid_tool_calls:
            return None

        log_diagnostic(
            "model_turn_diagnostics_warning",
            agent=self.agent_name,
            reason="empty_ai_turn",
            message_id=getattr(last_ai_message, "id", None),
            response_metadata=getattr(last_ai_message, "response_metadata", None),
        )
        return None
