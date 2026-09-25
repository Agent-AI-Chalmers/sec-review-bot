"""Persist the readable conversation produced by an agent as a JSON array."""

import json
from pathlib import Path
from threading import Lock
from typing import Any

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
        self._messages: list[dict[str, Any]] = []
        self._lock = Lock()

    def _persist(self) -> None:
        encoded = json.dumps(self._messages, ensure_ascii=False, indent=2)
        for path in self.paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(encoded + "\n", encoding="utf-8")

    def write_messages(self, messages: list | None) -> None:
        if messages is None:
            return
        with self._lock:
            self._messages.extend(serialize_agent_messages(messages))
            for index, message in enumerate(self._messages):
                message["index"] = index
            self._persist()

    def write_system_prompt(self, system_prompt: str) -> None:
        """Export the prompt as the first message in the conversation."""
        self.write_messages([{"type": "system", "content": system_prompt}])
