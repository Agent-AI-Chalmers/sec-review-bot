"""Normalize model-adapter usage at the trajectory producer boundary."""

import warnings
from collections.abc import Mapping
from typing import Any

TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_tokens",
)
MAX_TOKEN_COUNT = 9007199254740991


def token_count(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= MAX_TOKEN_COUNT else None


def validate_token_usage(value: Any) -> None:
    """The wire value is closed, nullable, and uses inclusive totals."""
    if value is None:
        return
    if not isinstance(value, dict) or set(value) != set(TOKEN_FIELDS):
        raise ValueError("Trajectory usage requires the canonical token fields")
    for count in value.values():
        if count is not None and token_count(count) is None:
            raise ValueError("Invalid trajectory token count")
    input_tokens = value["input_tokens"]
    output_tokens = value["output_tokens"]
    expected = (
        input_tokens + output_tokens
        if input_tokens is not None and output_tokens is not None
        else None
    )
    if value["total_tokens"] != expected:
        raise ValueError("Trajectory total must equal inclusive input plus output")
    caches = [value["cache_read_input_tokens"], value["cache_creation_input_tokens"]]
    if input_tokens is not None and sum(c or 0 for c in caches) > input_tokens:
        raise ValueError("Trajectory cache subsets exceed input tokens")
    reasoning = value["reasoning_tokens"]
    if (
        output_tokens is not None
        and reasoning is not None
        and reasoning > output_tokens
    ):
        raise ValueError("Trajectory reasoning subset exceeds output tokens")


def _canonical(
    input_tokens: int | None,
    output_tokens: int | None,
    cache_read: int | None,
    cache_creation: int | None,
    reasoning: int | None,
    source_total: Any,
) -> dict[str, int | None] | None:
    total = (
        input_tokens + output_tokens
        if input_tokens is not None and output_tokens is not None
        else None
    )
    reported_total = token_count(source_total)
    if reported_total is not None and total is not None and reported_total != total:
        warnings.warn("trajectory_source_total_mismatch", RuntimeWarning, stacklevel=3)
    result: dict[str, int | None] = dict(
        zip(
            TOKEN_FIELDS,
            (input_tokens, output_tokens, total, cache_read, cache_creation, reasoning),
            strict=True,
        )
    )
    validate_token_usage(result)
    return result if any(v is not None for v in result.values()) else None


def _langchain_detail_count(details: Mapping[str, Any], field: str) -> int | None:
    """Recombine LangChain's disjoint buckets for one token subset.

    OpenAI splits cache and reasoning counts by service tier (flex/priority).
    Anthropic splits cache creation by TTL (5 minutes/1 hour), with LangChain
    zeroing the generic cache-creation bucket when those TTL counts are used.
    These detail buckets are additive, so sum them rather than selecting a
    fallback. No reported count stays unknown; an explicit zero stays zero.
    The result is already included in LangChain's inclusive input/output totals
    and must not be added to those totals again.
    """
    keys: tuple[str, ...] = (field, f"flex_{field}", f"priority_{field}")
    if field == "cache_creation":
        keys += ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")
    counts = [
        count for key in keys if (count := token_count(details.get(key))) is not None
    ]
    return sum(counts) if counts else None


def normalize_langchain_usage(value: Mapping[str, Any]) -> dict[str, int | None] | None:
    input_details = value.get("input_token_details")
    output_details = value.get("output_token_details")
    input_details = input_details if isinstance(input_details, Mapping) else {}
    output_details = output_details if isinstance(output_details, Mapping) else {}
    return _canonical(
        token_count(value.get("input_tokens")),
        token_count(value.get("output_tokens")),
        _langchain_detail_count(input_details, "cache_read"),
        _langchain_detail_count(input_details, "cache_creation"),
        _langchain_detail_count(output_details, "reasoning"),
        value.get("total_tokens"),
    )


def normalize_provider_usage(value: Mapping[str, Any]) -> dict[str, int | None] | None:
    """Handle explicit OpenAI or Anthropic response usage, never infer a wire shape."""
    if "prompt_tokens" in value or "completion_tokens" in value:
        input_details = value.get("prompt_tokens_details")
        output_details = value.get("completion_tokens_details")
        input_details = input_details if isinstance(input_details, Mapping) else {}
        output_details = output_details if isinstance(output_details, Mapping) else {}
        return _canonical(
            token_count(value.get("prompt_tokens")),
            token_count(value.get("completion_tokens")),
            token_count(input_details.get("cached_tokens")),
            None,
            token_count(output_details.get("reasoning_tokens")),
            value.get("total_tokens"),
        )
    ordinary_input = token_count(value.get("input_tokens"))
    cache_read = token_count(value.get("cache_read_input_tokens"))
    cache_creation = token_count(value.get("cache_creation_input_tokens"))
    # This adapter's input bucket excludes cache. Absent optional cache buckets
    # add nothing to its total, but do not establish a reported subset value.
    return _canonical(
        (
            None
            if ordinary_input is None
            else ordinary_input + (cache_read or 0) + (cache_creation or 0)
        ),
        token_count(value.get("output_tokens")),
        cache_read,
        cache_creation,
        None,
        value.get("total_tokens"),
    )


def message_token_usage(message: Any) -> dict[str, int | None] | None:
    get = (
        message.get
        if isinstance(message, Mapping)
        else lambda k: getattr(message, k, None)
    )
    usage = get("usage_metadata")
    if isinstance(usage, Mapping):
        normalized = normalize_langchain_usage(usage)
        if normalized is not None:
            return normalized
    response = get("response_metadata")
    if isinstance(response, Mapping):
        for key in ("token_usage", "usage"):
            raw = response.get(key)
            if isinstance(raw, Mapping):
                normalized = (
                    normalize_langchain_usage(raw)
                    if "input_token_details" in raw or "output_token_details" in raw
                    else normalize_provider_usage(raw)
                )
                if normalized is not None:
                    return normalized
    return None
