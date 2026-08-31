"""Persist agent transcripts as JSONL run artifacts.

Transcript records come from two sources. The runtime graph invoker writes
run-level events directly, such as start/end, prompt snapshots, structured
responses, and errors. TranscriptCallbackHandler is only the LangChain callback
bridge; it adds model/tool events emitted during the agent invocation to the
same writer.
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

from sec_review_agents.utils.serialization import json_safe


def _message_type(message: Any) -> str:
    message_type = getattr(message, "type", None)
    if isinstance(message_type, str) and message_type.strip():
        return message_type

    get_type = getattr(message, "get_type", None)
    if callable(get_type):
        try:
            resolved = get_type()
            if isinstance(resolved, str) and resolved.strip():
                return resolved
        except Exception:
            pass

    if isinstance(message, dict):
        value = message.get("type") or message.get("role")
        if isinstance(value, str) and value.strip():
            return value

    return "unknown"


def serialize_agent_message(message: Any, index: int) -> dict:
    if isinstance(message, dict):
        return {
            "index": index,
            "type": _message_type(message),
            "id": message.get("id"),
            "name": message.get("name"),
            "content": json_safe(message.get("content")),
            "additional_kwargs": json_safe(message.get("additional_kwargs", {})),
            "response_metadata": json_safe(message.get("response_metadata", {})),
            "tool_calls": json_safe(message.get("tool_calls", [])),
            "invalid_tool_calls": json_safe(message.get("invalid_tool_calls", [])),
            "tool_call_chunks": json_safe(message.get("tool_call_chunks", [])),
            "usage_metadata": json_safe(message.get("usage_metadata")),
        }
    return {
        "index": index,
        "type": _message_type(message),
        "id": getattr(message, "id", None),
        "name": getattr(message, "name", None),
        "content": json_safe(getattr(message, "content", None)),
        "additional_kwargs": json_safe(getattr(message, "additional_kwargs", {})),
        "response_metadata": json_safe(getattr(message, "response_metadata", {})),
        "tool_calls": json_safe(getattr(message, "tool_calls", [])),
        "invalid_tool_calls": json_safe(getattr(message, "invalid_tool_calls", [])),
        "tool_call_chunks": json_safe(getattr(message, "tool_call_chunks", [])),
        "usage_metadata": json_safe(getattr(message, "usage_metadata", None)),
    }


def serialize_agent_messages(messages: list | None) -> list[dict]:
    if messages is None:
        return []
    return [
        serialize_agent_message(message, index)
        for index, message in enumerate(messages)
    ]


class TranscriptWriter:
    def __init__(
        self,
        paths: tuple[Path, ...],
        *,
        agent_name: str | None = None,
    ) -> None:
        if not paths:
            raise ValueError("TranscriptWriter requires at least one path.")
        self.paths = paths
        self.path = self.paths[0]
        self.agent_name = agent_name
        self._seq = 0
        self._lock = Lock()

    def write_event(self, event: str, **payload: Any) -> None:
        with self._lock:
            self._seq += 1
            record = {
                "seq": self._seq,
                "ts": datetime.now(UTC).isoformat(),
                "event": event,
            }
            if self.agent_name:
                record["agent"] = self.agent_name
            record.update({key: json_safe(value) for key, value in payload.items()})
            encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            for path in self.paths:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as transcript_file:
                    transcript_file.write(encoded)
                    transcript_file.write("\n")

    def write_messages(self, messages: list | None, *, event: str = "message") -> None:
        for message in serialize_agent_messages(messages):
            self.write_event(event, message=message)


class TranscriptCallbackHandler(BaseCallbackHandler):
    def __init__(self, writer: TranscriptWriter) -> None:
        self.writer = writer

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        **kwargs: Any,
    ) -> None:
        self.writer.write_event(
            "chat_model_start",
            run_id=str(kwargs.get("run_id")),
            parent_run_id=(
                str(kwargs.get("parent_run_id"))
                if kwargs.get("parent_run_id") is not None
                else None
            ),
            model=serialized.get("name") or serialized.get("id"),
            messages=[
                serialize_agent_messages(list(message_batch))
                for message_batch in messages
            ],
        )

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        generations = getattr(response, "generations", None)
        self.writer.write_event(
            "llm_end",
            run_id=str(kwargs.get("run_id")),
            parent_run_id=(
                str(kwargs.get("parent_run_id"))
                if kwargs.get("parent_run_id") is not None
                else None
            ),
            response=json_safe(generations),
        )

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        self.writer.write_event(
            "llm_error",
            run_id=str(kwargs.get("run_id")),
            error_type=error.__class__.__name__,
            error=str(error),
        )

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        **kwargs: Any,
    ) -> None:
        self.writer.write_event(
            "tool_start",
            run_id=str(kwargs.get("run_id")),
            parent_run_id=(
                str(kwargs.get("parent_run_id"))
                if kwargs.get("parent_run_id") is not None
                else None
            ),
            tool=serialized.get("name") or serialized.get("id"),
            input=input_str,
            inputs=kwargs.get("inputs"),
        )

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        self.writer.write_event(
            "tool_end",
            run_id=str(kwargs.get("run_id")),
            parent_run_id=(
                str(kwargs.get("parent_run_id"))
                if kwargs.get("parent_run_id") is not None
                else None
            ),
            output=output,
        )

    def on_tool_error(self, error: BaseException, **kwargs: Any) -> None:
        self.writer.write_event(
            "tool_error",
            run_id=str(kwargs.get("run_id")),
            error_type=error.__class__.__name__,
            error=str(error),
        )
