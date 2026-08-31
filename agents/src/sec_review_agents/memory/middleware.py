from collections.abc import Awaitable, Callable
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, ModelResponse

from sec_review_agents.runtime.system_messages import append_to_system_message

MEMORY_INDEX_PATH = "/memory/MEMORY.md"
# Mirror the Claude Code-style memory shape: eagerly expose only a bounded
# MEMORY.md startup index, then let the agent read topic files on demand.
DEFAULT_MEMORY_INDEX_MAX_LINES = 200
DEFAULT_MEMORY_INDEX_MAX_CHARS = 25_000

MEMORY_SYSTEM_PROMPT = """
## Security Review Experience Memory

Reviewed security-review experience memory is available at `{index_path}`.

Use this memory as guidance only. It is not evidence for the current repository,
patch, or finding. Current security conclusions must still be grounded in the
current workflow input, repository files, tool results, and stage artifacts.

The memory index below is the progressive-disclosure entry point. Read topic
files only when they are relevant to the current stage, uncertainty, or review
discipline question. Do not treat observation files or SQLite state as memory.
Do not write to `/memory`. Do not use memory to start a finding without current
repository evidence.

### Memory Index

```md
{memory_index}
```
""".strip()

MISSING_MEMORY_INDEX = (
    "Memory index is not available for this run. Continue without memory and do "
    "not infer prior review experience."
)


def _content_from_read_result(read_result: Any) -> str | None:
    if getattr(read_result, "error", None):
        return None
    file_data = getattr(read_result, "file_data", None)
    if not isinstance(file_data, dict):
        return None
    content = file_data.get("content")
    return content if isinstance(content, str) else None


def _trim_memory_index(content: str, *, max_lines: int, max_chars: int) -> str:
    lines = content.splitlines()
    trimmed = "\n".join(lines[:max_lines]).strip()
    if len(trimmed) > max_chars:
        trimmed = trimmed[:max_chars].rstrip()
    return trimmed or "(empty memory index)"


class MemoryMiddleware(AgentMiddleware):
    """Expose reviewed experience memory through progressive disclosure."""

    def __init__(
        self,
        *,
        backend: BackendProtocol | None = None,
        index_path: str = MEMORY_INDEX_PATH,
        index_max_lines: int = DEFAULT_MEMORY_INDEX_MAX_LINES,
        index_max_chars: int = DEFAULT_MEMORY_INDEX_MAX_CHARS,
        system_prompt_template: str = MEMORY_SYSTEM_PROMPT,
    ) -> None:
        self.backend = backend
        self.index_path = index_path
        self.index_max_lines = index_max_lines
        self.index_max_chars = index_max_chars
        self.system_prompt_template = system_prompt_template

    def _read_memory_index(self) -> str:
        if self.backend is None:
            return MISSING_MEMORY_INDEX
        try:
            content = _content_from_read_result(
                self.backend.read(
                    self.index_path,
                    offset=0,
                    limit=self.index_max_lines,
                )
            )
        except Exception:
            content = None
        if content is None:
            return MISSING_MEMORY_INDEX
        return _trim_memory_index(
            content,
            max_lines=self.index_max_lines,
            max_chars=self.index_max_chars,
        )

    def system_prompt(self) -> str:
        return self.system_prompt_template.format(
            index_path=self.index_path,
            memory_index=self._read_memory_index(),
        )

    def modify_request(self, request: ModelRequest) -> ModelRequest:
        new_system_message = append_to_system_message(
            request.system_message,
            self.system_prompt(),
        )
        return request.override(system_message=new_system_message)

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(self.modify_request(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        return await handler(self.modify_request(request))
