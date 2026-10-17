"""Evidence for skill probes; a model's path self-report is not a read receipt."""

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from langchain_core.messages import AIMessage, ToolMessage, messages_to_dict

from sec_review_agents.resources.paths import AGENT_SKILLS
from sec_review_agents.utils.serialization import json_safe
from tests.llm_probe import llm_test_deployment


def successful_read_paths(result: dict[str, Any]) -> set[str]:
    pending: dict[str, str] = {}
    successful: set[str] = set()
    for message in result.get("messages", []):
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                if call["name"] == "read_file":
                    path = call["args"].get("file_path") or call["args"].get("path")
                    call_id = call.get("id")
                    if isinstance(path, str) and isinstance(call_id, str):
                        pending[call_id] = path
        elif isinstance(message, ToolMessage):
            path = pending.pop(message.tool_call_id, None)
            if (
                path is not None
                and message.status == "success"
                and message.content
                and not message.text.lstrip().startswith("Error")
            ):
                successful.add(path)
    return successful


def record_skill_probe_result(
    result: dict[str, Any],
    *,
    label: str,
    metadata: Mapping[str, Any] | None = None,
) -> None:
    artifact = Path(".agent-artifacts") / "skill-probes" / f"{label}-{uuid4().hex}.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    reads = successful_read_paths(result)
    hashes = {}
    for path in sorted(reads):
        if not path.startswith("/skills/") or ".." in Path(path).parts:
            continue
        resource = AGENT_SKILLS.joinpath(path.removeprefix("/skills/"))
        if resource.is_file():
            hashes[path] = hashlib.sha256(resource.read_bytes()).hexdigest()
    artifact.write_text(
        json.dumps(
            {
                "deployment": llm_test_deployment(),
                "messages": messages_to_dict(result.get("messages", [])),
                "structured_response": json_safe(result.get("structured_response")),
                "successful_read_paths": sorted(reads),
                "resource_hashes": hashes,
                "metadata": json_safe(metadata or {}),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"skill probe artifact: {artifact}")
