from contextvars import ContextVar

_TRACE_CONTEXT: ContextVar[dict[str, str] | None] = ContextVar(
    "sec_review_trace_context",
    default=None,
)


def _normalized_context_value(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        raise ValueError("Trace context value must not be blank.")
    return stripped


def bind_trace_context(**context_labels: str | None) -> None:
    context = dict(_TRACE_CONTEXT.get() or {})
    # Inside the function, **context_labels is a dict[str, str | None].
    for key, value in context_labels.items():
        if value is not None and not isinstance(value, str):
            raise TypeError(
                "Trace context value must be str or None, "
                f"got {type(value).__name__}."
            )
        normalized = _normalized_context_value(value)
        if normalized is not None:
            context[key] = normalized
    _TRACE_CONTEXT.set(context)


def clear_trace_context() -> None:
    _TRACE_CONTEXT.set({})


def current_trace_context() -> dict[str, str]:
    return dict(_TRACE_CONTEXT.get() or {})
