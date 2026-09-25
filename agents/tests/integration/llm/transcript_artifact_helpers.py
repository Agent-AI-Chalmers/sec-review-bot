import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

FILESYSTEM_TOOL_NAMES = {
    "read_file",
    "ls",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "execute",
}

ToolUsageObservation = Callable[[dict[str, Any]], dict[str, Any]]


def transcript_messages(transcript_path: Path) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    transcript_files = (
        [transcript_path]
        if transcript_path.is_file()
        else sorted(transcript_path.glob("*.json"))
    )
    for transcript_file in transcript_files:
        value = json.loads(transcript_file.read_text(encoding="utf-8"))
        if isinstance(value, list):
            messages.extend(item for item in value if isinstance(item, dict))
    return messages


def message_tool_call_names(message: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for tool_call in message.get("tool_calls") or []:
        name = tool_call.get("name") if isinstance(tool_call, dict) else None
        if isinstance(name, str):
            names.append(name)

    content = message.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if isinstance(name, str):
                names.append(name)

    return names


def message_read_file_paths(message: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for tool_call in message.get("tool_calls") or []:
        if not isinstance(tool_call, dict) or tool_call.get("name") != "read_file":
            continue
        args = tool_call.get("args")
        if not isinstance(args, dict):
            continue
        path = args.get("file_path") or args.get("path")
        if isinstance(path, str):
            paths.append(path)
    return paths


def read_file_paths_from_transcript(transcript_path: Path) -> list[str]:
    paths: list[str] = []
    for message in transcript_messages(transcript_path):
        paths.extend(message_read_file_paths(message))
    return paths


def message_execute_commands(message: dict[str, Any]) -> list[str]:
    commands: list[str] = []
    for tool_call in message.get("tool_calls") or []:
        if not isinstance(tool_call, dict) or tool_call.get("name") != "execute":
            continue
        args = tool_call.get("args")
        if not isinstance(args, dict):
            continue
        command = args.get("command")
        if isinstance(command, str):
            commands.append(command)
    return commands


def message_tool_errors(message: dict[str, Any]) -> list[dict[str, str]]:
    if message.get("type") != "tool":
        return []
    content = message.get("content")
    if not isinstance(content, str) or not content.startswith("Error:"):
        return []
    name = message.get("name")
    return [
        {
            "tool": name if isinstance(name, str) else "",
            "error": content,
        }
    ]


def looks_like_git_command(command: str) -> bool:
    stripped = command.strip()
    return (
        stripped == "git" or stripped.startswith("git ") or " git " in f" {stripped} "
    )


def empty_tool_usage(
    observations: tuple[ToolUsageObservation, ...] = (),
) -> dict[str, Any]:
    usage: dict[str, Any] = {
        "totalToolCalls": 0,
        "filesystemToolCalls": 0,
        "executeCalls": 0,
        "gitCommandCalls": 0,
        "gitCommands": [],
        "executeCommands": [],
        "toolErrors": [],
        "readPaths": [],
        "toolNames": [],
    }
    return _apply_observations(usage, observations)


def tool_usage_from_transcript(
    transcript_path: Path,
    observations: tuple[ToolUsageObservation, ...] = (),
) -> dict[str, Any]:
    names: list[str] = []
    read_paths: list[str] = []
    execute_commands: list[str] = []
    tool_errors: list[dict[str, str]] = []

    for message in transcript_messages(transcript_path):
        names.extend(message_tool_call_names(message))
        read_paths.extend(message_read_file_paths(message))
        execute_commands.extend(message_execute_commands(message))
        tool_errors.extend(message_tool_errors(message))

    git_commands = [
        command for command in execute_commands if looks_like_git_command(command)
    ]

    usage: dict[str, Any] = {
        "totalToolCalls": len(names),
        "filesystemToolCalls": sum(name in FILESYSTEM_TOOL_NAMES for name in names),
        "executeCalls": len(execute_commands),
        "gitCommandCalls": len(git_commands),
        "gitCommands": git_commands,
        "executeCommands": execute_commands,
        "toolErrors": tool_errors,
        "readPaths": read_paths,
        "toolNames": names,
    }
    return _apply_observations(usage, observations)


def _apply_observations(
    usage: dict[str, Any],
    observations: tuple[ToolUsageObservation, ...],
) -> dict[str, Any]:
    for observation in observations:
        usage |= observation(usage)
    return usage
