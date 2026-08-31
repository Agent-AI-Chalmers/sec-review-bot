import logging
import os
import sys
from typing import Any

import structlog

from sec_review_agents.observability.trace_context import current_trace_context


def _merge_trace_context(
    logger: Any, method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    for key, value in current_trace_context().items():
        event_dict.setdefault(key, value)
    return event_dict


def _human_format_duration(
    logger: Any, method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    duration_ms = event_dict.get("duration_ms")
    if isinstance(duration_ms, (int, float)):
        seconds = duration_ms / 1000.0
        if seconds < 1:
            event_dict["duration"] = f"{duration_ms:.0f}ms"
        elif seconds < 60:
            event_dict["duration"] = f"{seconds:.2f}s"
        else:
            minutes = int(seconds // 60)
            secs = seconds % 60
            event_dict["duration"] = f"{minutes}m {secs:.1f}s"
        del event_dict["duration_ms"]
    return event_dict


def _setup_logger() -> structlog.BoundLogger:
    shared_processors: list[Any] = [
        _merge_trace_context,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    is_dev = os.environ.get("AGENT_ENVIRONMENT", "dev").lower() == "dev"
    if is_dev:
        processors = shared_processors + [
            _human_format_duration,
            # Keep dev logs human-readable but avoid ANSI escape sequences in file logs.
            structlog.dev.ConsoleRenderer(colors=False),
        ]
    else:
        processors = shared_processors + [
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ]

    log_level_name = os.environ.get("AGENT_LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_name, logging.INFO)

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=False,
    )

    return structlog.get_logger("agent")


logger = _setup_logger()
