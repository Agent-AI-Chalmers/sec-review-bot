from typing import Any

from langchain_core.messages import AIMessage


def int_token_value(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def usage_from_langchain_metadata(value: dict[str, Any]) -> dict[str, int] | None:
    input_tokens = int_token_value(value.get("input_tokens"))
    output_tokens = int_token_value(value.get("output_tokens"))
    total_tokens = int_token_value(value.get("total_tokens"))
    cache_read_tokens = int_token_value(value.get("cache_read_input_tokens"))
    if input_tokens is None and output_tokens is None:
        return None

    input_details = value.get("input_token_details")
    output_details = value.get("output_token_details")
    billed_input_tokens = (input_tokens or 0) + (cache_read_tokens or 0)
    usage = {
        "input_tokens": billed_input_tokens,
        "output_tokens": output_tokens or 0,
        "total_tokens": total_tokens or (billed_input_tokens + (output_tokens or 0)),
        "cache_read_tokens": 0,
        "reasoning_tokens": 0,
    }
    if cache_read_tokens is not None:
        usage["cache_read_tokens"] = cache_read_tokens
    if isinstance(input_details, dict):
        usage["cache_read_tokens"] = (
            int_token_value(input_details.get("cache_read")) or 0
        )
    if isinstance(output_details, dict):
        usage["reasoning_tokens"] = (
            int_token_value(output_details.get("reasoning")) or 0
        )
    return usage


def usage_from_provider_metadata(value: dict[str, Any]) -> dict[str, int] | None:
    prompt_tokens = int_token_value(value.get("prompt_tokens"))
    completion_tokens = int_token_value(value.get("completion_tokens"))
    total_tokens = int_token_value(value.get("total_tokens"))
    if prompt_tokens is None and completion_tokens is None:
        return None

    prompt_details = value.get("prompt_tokens_details")
    completion_details = value.get("completion_tokens_details")
    usage = {
        "input_tokens": prompt_tokens or 0,
        "output_tokens": completion_tokens or 0,
        "total_tokens": total_tokens
        or ((prompt_tokens or 0) + (completion_tokens or 0)),
        "cache_read_tokens": 0,
        "reasoning_tokens": 0,
    }
    if isinstance(prompt_details, dict):
        usage["cache_read_tokens"] = (
            int_token_value(prompt_details.get("cached_tokens")) or 0
        )
    if isinstance(completion_details, dict):
        usage["reasoning_tokens"] = (
            int_token_value(completion_details.get("reasoning_tokens")) or 0
        )
    return usage


def usage_from_ai_message(message: AIMessage) -> dict[str, int] | None:
    usage_metadata = getattr(message, "usage_metadata", None)
    if isinstance(usage_metadata, dict):
        usage = usage_from_langchain_metadata(usage_metadata)
        if usage is not None:
            return usage

    response_metadata = getattr(message, "response_metadata", None)
    if isinstance(response_metadata, dict):
        token_usage = response_metadata.get("token_usage")
        if isinstance(token_usage, dict):
            usage = usage_from_provider_metadata(token_usage)
            if usage is not None:
                return usage
        response_usage = response_metadata.get("usage")
        if isinstance(response_usage, dict):
            usage = usage_from_langchain_metadata(response_usage)
            if usage is not None:
                return usage

    return None
