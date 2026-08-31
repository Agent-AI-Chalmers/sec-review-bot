from deepagents import FilesystemMiddleware
from deepagents.backends.protocol import BackendProtocol

_EXECUTE_TOOL_TIMEOUT_DESCRIPTION = """
Executes a shell command in an isolated sandbox environment.

Usage notes:
- `timeout` is in seconds (not milliseconds).
- Maximum allowed `timeout` is 3600 seconds.
- If you mean 30 seconds, use `timeout=30` (not `timeout=30000`).
- Preserve the real exit status of the command that matters.
- If you use a shell pipeline, explicitly preserve failure status first, for example with `set -o pipefail`.
- Do not run pipelines or post-processing such as `head`, `tail`, `grep`, or `sed` after a command whose success you are trying to verify unless failure status is explicitly preserved.
- Never claim a command succeeded if the shell wrapper or pipeline could have masked the upstream exit code.

Examples:
- Good: `set -o pipefail && pip install -e . 2>&1 | tail -5`
- Good: `pip install -e .`
- Bad: `pip install -e . 2>&1 | tail -5`
"""

_GREP_TOOL_DESCRIPTION = """
Search for a single literal text pattern across files.

Usage notes:
- `pattern` is plain text, not regex.
- Do not use regex operators such as `|`, `.`, `*`, `+`, `?`, `^`, `$`, `()`, `[]`, or `{}` as pattern syntax.
- Do not add regex-style escaping such as `\\.` or `\\w`; backslashes are treated as literal characters.
- Search for the exact substring you want to find.
- If you want to search for multiple alternatives like `foo` or `bar`, run separate grep calls for each pattern.

Examples:
- Good: `grep(pattern="WithUser", path="/workspace", output_mode="content")`
- Good: `grep(pattern="WithAdditionalGids", path="/workspace", output_mode="content")`
- Good: `grep(pattern="user.name", path="/workspace", output_mode="content")`
- Good: `grep(pattern="safe", path="/workspace", output_mode="files_with_matches")`
- Bad: `grep(pattern="WithUser|WithAdditionalGids", path="/workspace", output_mode="content")`
- Bad: `grep(pattern="user\\.name", path="/workspace", output_mode="content")`
- Bad: `grep(pattern="safe", path="/workspace", output_mode="files_with_match")`
"""

_READ_FILE_TOOL_DESCRIPTION = """
Read file contents by line range.

Usage notes:
- If you omit `limit`, the tool defaults to 100 lines.
- Do not assume 100 lines is always enough.
- When you need contiguous code context, prefer a larger explicit limit such as `200` or `300`.
- Use `offset` and `limit` together to continue reading large files in chunks.
- For focused inspection, read the smallest range that still preserves the surrounding context you need.

Examples:
- First pass: `read_file(file_path="/workspace/app.py", offset=0, limit=200)`
- Continue: `read_file(file_path="/workspace/app.py", offset=200, limit=200)`
- Small targeted read: `read_file(file_path="/workspace/app.py", offset=520, limit=80)`
"""


def create_filesystem_middleware(
    *,
    backend: BackendProtocol | None,
    system_prompt: str | None = None,
    human_message_token_limit_before_evict: int | None = None,
) -> FilesystemMiddleware:
    # Agents receive orchestrator-built task contracts as their first
    # HumanMessage. Those inputs are authoritative, not casual chat history, so
    # oversized input should be budgeted by the stage instead of silently
    # offloaded to /conversation_history before the model sees it.
    return FilesystemMiddleware(
        backend=backend,
        system_prompt=system_prompt,
        human_message_token_limit_before_evict=human_message_token_limit_before_evict,
        custom_tool_descriptions={
            "execute": _EXECUTE_TOOL_TIMEOUT_DESCRIPTION,
            "grep": _GREP_TOOL_DESCRIPTION,
            "read_file": _READ_FILE_TOOL_DESCRIPTION,
        },
    )
