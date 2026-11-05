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
# acceptance checks for already-produced structured responses, such as committed
# patch delivery, belong to their own middleware.

import json
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
        "The previous tool call arguments were rejected. "
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

        return {
            "jump_to": "model",
            "missing_structured_response_retry_count": retry_count + 1,
            "messages": [HumanMessage(content=self._build_retry_prompt(last_message))],
        }

    async def aafter_model(
        self,
        state: MissingStructuredResponseState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        return self.after_model(state, runtime)

    def _build_retry_prompt(self, message: Any) -> str:
        invalid_calls = []
        if isinstance(message, AIMessage):
            invalid_calls = message.invalid_tool_calls
        elif isinstance(message, dict):
            invalid_calls = message.get("invalid_tool_calls") or []
        if not invalid_calls:
            return self.retry_prompt
        return (
            f"{self._INVALID_TOOL_ARGUMENTS_RETRY_PROMPT}\n"
            f"{_invalid_arguments_feedback(invalid_calls)}\n\n"
            "Return the required structured response using the configured "
            "structured-output mechanism."
        )


def _is_terminal_ai_message(message: Any) -> bool:
    if isinstance(message, AIMessage):
        return not message.tool_calls
    if isinstance(message, dict):
        message_type = message.get("role") or message.get("type")
        if message_type not in {"assistant", "ai"}:
            return False
        return not message.get("tool_calls")
    return False


def _invalid_arguments_feedback(calls: list[Any]) -> str:
    """Diagnose retained arguments without repairing them or echoing whole payloads."""
    diagnostics = []
    # Bound feedback even if a model emits many invalid calls or very long text.
    for call in calls[:3]:
        detail: dict[str, Any] = {"tool": str(call.get("name") or "unknown")[:100]}
        detail.update(_diagnose_arguments(call.get("args")))
        diagnostics.append(json.dumps(detail, ensure_ascii=True))
    if len(calls) > 3:
        diagnostics.append(f"{len(calls) - 3} further invalid calls omitted.")
    return "Argument diagnostics (JSON data; offsets are zero-based):\n" + "\n".join(
        diagnostics
    )


def _diagnose_arguments(arguments: Any) -> dict[str, Any]:
    """Describe a rejected payload without changing its arguments."""
    if not isinstance(arguments, str):
        return {"error": "No raw JSON arguments were retained."}
    try:
        parsed = json.loads(arguments)
    except json.JSONDecodeError as error:
        context_start = max(0, error.pos - 80)
        return {
            "error": error.msg,
            "line": error.lineno,
            "column": error.colno,
            "offset": error.pos,
            "context_start": context_start,
            "context": arguments[context_start : error.pos + 80],
        }
    except RecursionError:
        return {"error": "JSON nesting is too deep to parse."}
    except ValueError as error:
        # Conversion limits (for example oversized integers) are not syntax errors.
        return {"error": f"JSON value could not be parsed: {str(error)[:300]}"}
    if not isinstance(parsed, dict):
        return {
            "error": f"Arguments must be a JSON object, not {type(parsed).__name__}."
        }
    return {
        "error": "Arguments are a JSON object locally, but the tool parser "
        "rejected the call; resend it using the configured schema."
    }
