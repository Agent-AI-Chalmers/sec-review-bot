from deepagents import FilesystemMiddleware
from deepagents.backends.protocol import BackendProtocol


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
    )
