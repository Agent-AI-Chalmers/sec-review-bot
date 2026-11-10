# Deep Agents' MemoryMiddleware conflates maintainer-authored AGENTS.md guidance
# with agent-learned memory. Its default prompt encourages writing learnings back
# through edit_file, and its whole-file loader has no startup context budget.
# It also reuses checkpointed contents without refreshing changed sources.
# Use a bounded, per-invocation snapshot here; experience extraction and
# maintenance remain separate from maintainer-authored project guidance.

"""Load root AGENTS.md into the system message without memory write-back."""

import re
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, NotRequired

from deepagents.backends.protocol import BackendProtocol, ReadResult
from deepagents.backends.utils import EMPTY_CONTENT_WARNING
from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain.agents.middleware.types import (
    ModelRequest,
    ModelResponse,
    PrivateStateAttr,
)
from langgraph.runtime import Runtime

from sec_review_agents.resources.loader import load_prompt_resource
from sec_review_agents.runtime.system_messages import append_to_system_message

REPOSITORY_INSTRUCTIONS_MAX_LINES = 1000
REPOSITORY_INSTRUCTIONS_MAX_CHARS = 64_000
_HTML_COMMENTS = re.compile(r"<!--.*?-->", re.DOTALL)


class ProjectInstructionsState(AgentState):
    repository_instructions: NotRequired[Annotated[str, PrivateStateAttr]]


class ProjectInstructionsMiddleware(AgentMiddleware[ProjectInstructionsState]):
    """Refresh guidance between invocations and keep it fixed within each tool loop."""

    state_schema = ProjectInstructionsState

    def __init__(
        self, *, backend: BackendProtocol, workspace_root: str = "/workspace"
    ) -> None:
        self.backend = backend
        self.instructions_prompt = load_prompt_resource(
            "repository-instructions/system.md", workspace_root=workspace_root
        )
        self.instructions_path = f"{workspace_root}/AGENTS.md"

    def _format_read(self, result: ReadResult) -> str:
        # CompositeBackend may report a route-relative filename in read errors.
        if (
            result.error
            and result.error.startswith("File '")
            and result.error.endswith("' not found")
        ):
            return ""
        if result.error or result.file_data is None:
            return self._unavailable("the backend could not read the file")
        if result.file_data["encoding"] != "utf-8":
            return self._unavailable("the file is not UTF-8 text")
        content = result.file_data["content"]
        # Upstream represents empty files as a tool-facing reminder, not guidance.
        if content == EMPTY_CONTENT_WARNING:
            return ""
        # A truncated file could omit qualifications that change earlier instructions.
        if (
            result.next_offset is not None
            or len(content.splitlines()) > REPOSITORY_INSTRUCTIONS_MAX_LINES
            or len(content) > REPOSITORY_INSTRUCTIONS_MAX_CHARS
        ):
            return self._unavailable("the file exceeds the startup guidance budget")
        # Keep non-rendered document metadata out of model-facing guidance.
        content = _HTML_COMMENTS.sub("", content).strip()
        if not content:
            return ""
        return (
            f"{self.instructions_prompt}\n\n"
            f'<repository_instructions source="{self.instructions_path}">\n'
            f"{content}\n</repository_instructions>"
        )

    def _unavailable(self, reason: str) -> str:
        return (
            f"# Repository Guidance\n\n{self.instructions_path} was not loaded: "
            f"{reason}. Continue from the supplied task and repository evidence; "
            "consult relevant file sections if needed."
        )

    def before_agent(
        self, state: ProjectInstructionsState, runtime: Runtime
    ) -> dict[str, Any]:
        # Refresh resumed threads too; only the current tool loop shares this snapshot.
        result = self.backend.read(
            self.instructions_path,
            offset=0,
            limit=REPOSITORY_INSTRUCTIONS_MAX_LINES + 1,
        )
        return {"repository_instructions": self._format_read(result)}

    async def abefore_agent(
        self, state: ProjectInstructionsState, runtime: Runtime
    ) -> dict[str, Any]:
        result = await self.backend.aread(
            self.instructions_path,
            offset=0,
            limit=REPOSITORY_INSTRUCTIONS_MAX_LINES + 1,
        )
        return {"repository_instructions": self._format_read(result)}

    def modify_request(self, request: ModelRequest) -> ModelRequest:
        guidance = request.state.get("repository_instructions", "")
        if not isinstance(guidance, str) or not guidance:
            return request
        return request.override(
            system_message=append_to_system_message(request.system_message, guidance)
        )

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
