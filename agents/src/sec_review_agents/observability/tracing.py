from collections.abc import Callable, Mapping
from dataclasses import dataclass

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.runnables import RunnableConfig

from sec_review_agents.observability.diagnostics import log_diagnostic
from sec_review_agents.observability.trace_context import current_trace_context
from sec_review_agents.utils.env import env_value

_LANGFUSE_IMPORT_WARNING_EMITTED = False


@dataclass(frozen=True)
class TracingConfig:
    enabled: bool
    callback: BaseCallbackHandler | None
    metadata: dict[str, str]
    run_name: str
    flush: Callable[[], None]

    def to_langchain_config(self) -> RunnableConfig:
        config: RunnableConfig = {
            "metadata": self.metadata,
            "run_name": self.run_name,
        }
        if self.callback is not None:
            config["callbacks"] = [self.callback]
        return config


def _string_metadata_value(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def _compact_string_metadata(values: Mapping[str, object]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in values.items():
        string_value = _string_metadata_value(value)
        if string_value is not None:
            normalized[key] = string_value
    return normalized


def _build_metadata(agent_name: str) -> dict[str, str]:
    trace_context = current_trace_context()
    return _compact_string_metadata(
        {
            "sec_review_agent": agent_name,
            "sec_review_workflow": trace_context.get("workflow"),
            "sec_review_run_id": trace_context.get("run_id"),
            "langfuse_session_id": trace_context.get("run_id"),
        }
    )


def _disabled_tracing_config(
    *,
    agent_name: str,
    metadata: dict[str, str],
) -> TracingConfig:
    return TracingConfig(
        enabled=False,
        callback=None,
        metadata=metadata,
        run_name=agent_name,
        flush=lambda: None,
    )


def tracing_configured() -> bool:
    # Keep this side-effect free: importing or initializing Langfuse happens only
    # when building the per-invocation tracing config.
    return all(
        env_value(name)
        for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL")
    )


def build_tracing_config(
    *,
    agent_name: str,
) -> TracingConfig:
    global _LANGFUSE_IMPORT_WARNING_EMITTED

    metadata = _build_metadata(agent_name)

    if not tracing_configured():
        return _disabled_tracing_config(agent_name=agent_name, metadata=metadata)

    try:
        from langfuse import get_client
        from langfuse.langchain import CallbackHandler

        client = get_client()
        callback = CallbackHandler()

        return TracingConfig(
            enabled=True,
            callback=callback,
            metadata=metadata,
            run_name=agent_name,
            flush=client.flush if hasattr(client, "flush") else (lambda: None),
        )
    except Exception as error:
        if not _LANGFUSE_IMPORT_WARNING_EMITTED:
            _LANGFUSE_IMPORT_WARNING_EMITTED = True
            log_diagnostic(
                "langfuse_tracing_unavailable",
                agent_name=agent_name,
                error_type=error.__class__.__name__,
                error=str(error),
            )

        return _disabled_tracing_config(agent_name=agent_name, metadata=metadata)
