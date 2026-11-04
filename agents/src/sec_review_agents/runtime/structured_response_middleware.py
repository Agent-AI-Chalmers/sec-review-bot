"""Recover structured-output turns with prose or unparseable tool arguments."""

# Design notes for maintainers:
#
# LangChain retries parsed tool arguments that fail schema validation. Malformed
# JSON instead becomes `invalid_tool_calls` and can bypass that retry path.
# This middleware also handles those turns when no valid tool call can proceed.
# An agent with tools may also terminate with a normal prose AI message before it
# ever calls the structured-output tool. For this project, that is a protocol
# failure: stages with a response schema must return `structured_response`.
#
# The important detail is the hook position: this uses `after_model` plus
# `jump_to="model"`, not `after_agent`. `after_model` runs after the model has
# produced a candidate terminal message but before the agent graph routes to
# tools or exits. That lets us reject terminal prose before it becomes the final
# graph result, append a correction message, and re-enter the model node inside
# the same agent graph invocation. `after_agent` would be too late: it is
# semantically post-run cleanup and would recreate the old "invoke again after
# the agent finished" shape.
#
# It only handles the missing-structured-response protocol failure. Runtime
# acceptance checks for already-produced structured responses, such as whether
# declared changed files match an observed workspace patch, belong to their own
# middleware.

from typing import Annotated, Any, ClassVar, NotRequired, override

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ContextT,
    OmitFromSchema,
    ResponseT,
    hook_config,
)
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.channels.untracked_value import UntrackedValue
from langgraph.runtime import Runtime

from sec_review_agents.utils.env import int_env

MISSING_STRUCTURED_RESPONSE_MAX_RETRIES_ENV = (
    "AGENT_MISSING_STRUCTURED_RESPONSE_MAX_RETRIES"
)
PRIVATE_STATE_ATTR = OmitFromSchema(input=True, output=True)


def missing_structured_response_max_retries() -> int:
    return int_env(MISSING_STRUCTURED_RESPONSE_MAX_RETRIES_ENV, 2, minimum=0)


class MissingStructuredResponseState(AgentState[ResponseT]):
    missing_structured_response_retry_count: NotRequired[
        Annotated[int, UntrackedValue, PRIVATE_STATE_ATTR]
    ]


class MissingStructuredResponseMiddleware(
    AgentMiddleware[MissingStructuredResponseState[ResponseT], ContextT, ResponseT]
):
    """Retry missing results, including tool arguments rejected before schema validation."""

    state_schema: type[MissingStructuredResponseState[ResponseT]] = (
        MissingStructuredResponseState
    )

    _MISSING_STRUCTURED_RESPONSE_RETRY_PROMPT: ClassVar[str] = (
        "Your previous response did not include the required structured response.\n\n"
        "This stage cannot accept a prose-only answer. "
        "Return the required structured response using the configured "
        "structured-output mechanism and populate every required field "
        "according to the schema.\n\n"
        "If this stage uses a structured output tool, call that tool exactly once. "
        "Do not finish with only text content.\n"
    )

    _INVALID_TOOL_ARGUMENTS_RETRY_PROMPT: ClassVar[str] = (
        "The previous tool arguments could not be parsed as JSON. "
        "Return valid JSON arguments: escape quotes and backslashes "
        "inside strings and close all objects and arrays."
    )

    def __init__(
        self,
        *,
        max_retries: int = 2,
        retry_prompt: str = _MISSING_STRUCTURED_RESPONSE_RETRY_PROMPT,
    ) -> None:
        self.max_retries = max(0, max_retries)
        self.retry_prompt = retry_prompt

    @hook_config(can_jump_to=["model"])
    @override
    def after_model(
        self,
        state: MissingStructuredResponseState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        _ = runtime
        if state.get("structured_response") is not None:
            return None

        messages = state.get("messages")
        if not isinstance(messages, list) or not messages:
            return None

        last_message = messages[-1]
        if not _is_terminal_ai_message(last_message):
            return None

        retry_count = state.get("missing_structured_response_retry_count", 0)
        if retry_count >= self.max_retries:
            raise RuntimeError(
                "Agent completed without structured_response. "
                f"Retried {retry_count} time(s) after missing structured output."
            )

        invalid_calls = False
        if isinstance(last_message, AIMessage):
            invalid_calls = bool(last_message.invalid_tool_calls)
        elif isinstance(last_message, dict):
            invalid_calls = bool(last_message.get("invalid_tool_calls"))
        retry_prompt = self.retry_prompt
        if invalid_calls:
            retry_prompt = (
                f"{self._INVALID_TOOL_ARGUMENTS_RETRY_PROMPT}\n\n{retry_prompt}"
            )

        return {
            "jump_to": "model",
            "missing_structured_response_retry_count": retry_count + 1,
            "messages": [HumanMessage(content=retry_prompt)],
        }

    async def aafter_model(
        self,
        state: MissingStructuredResponseState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        return self.after_model(state, runtime)


def _is_terminal_ai_message(message: Any) -> bool:
    if isinstance(message, AIMessage):
        return not message.tool_calls
    if isinstance(message, dict):
        message_type = message.get("role") or message.get("type")
        if message_type not in {"assistant", "ai"}:
            return False
        return not message.get("tool_calls")
    return False
