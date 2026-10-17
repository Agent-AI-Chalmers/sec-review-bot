from typing import Any

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from pydantic import BaseModel


class ToolCallingFakeMessagesListChatModel(FakeMessagesListChatModel):
    """Fake chat model that accepts LangChain structured-output tool binding."""

    def bind_tools(self, tools: Any, **kwargs: Any):
        object.__setattr__(self, "bound_tools", list(tools or []))
        object.__setattr__(self, "bound_tool_kwargs", dict(kwargs))
        return self


def structured_tool_call_message(
    schema: type[BaseModel],
    args: dict[str, Any],
    *,
    call_id: str = "call_1",
) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": schema.__name__,
                "args": args,
                "id": call_id,
            }
        ],
    )
