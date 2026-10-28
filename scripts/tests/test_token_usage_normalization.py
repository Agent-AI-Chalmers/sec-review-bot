from token_usage.normalization import (
    usage_from_langchain_metadata,
    usage_from_provider_metadata,
)


def test_langchain_detail_shape_is_not_claimed_by_provider_parser() -> None:
    value = {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "input_token_details": {"cache_read": 3, "cache_creation": 1},
        "output_token_details": {"reasoning": 1},
    }

    assert usage_from_provider_metadata(value) is None
    assert usage_from_langchain_metadata(value) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "cache_read_tokens": 3,
        "cache_creation_tokens": 1,
        "reasoning_tokens": 1,
    }


def test_anthropic_provider_buckets_become_inclusive_input() -> None:
    value = {
        "input_tokens": 6,
        "cache_read_input_tokens": 3,
        "cache_creation_input_tokens": 1,
        "output_tokens": 5,
        "total_tokens": 15,
    }

    assert usage_from_provider_metadata(value) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "cache_read_tokens": 3,
        "cache_creation_tokens": 1,
        "reasoning_tokens": 0,
    }
