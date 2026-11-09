"""Normalize at the producer boundary rather than guessing in trajectory readers."""

import pytest
from langchain_core.messages import AIMessage

from sec_review_agents.runtime.token_usage import (
    message_token_usage,
    normalize_langchain_usage,
    normalize_provider_usage,
)
from sec_review_agents.runtime.trajectories import (
    TrajectoryWriter,
    read_trajectory_messages,
)


def test_langchain_usage_is_inclusive_and_preserves_unknown_subsets():
    assert normalize_langchain_usage({"input_tokens": 10, "output_tokens": 5}) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "cache_read_input_tokens": None,
        "cache_creation_input_tokens": None,
        "reasoning_tokens": None,
    }


def test_anthropic_cache_buckets_are_added_once():
    assert normalize_provider_usage(
        {
            "input_tokens": 6,
            "output_tokens": 5,
            "cache_read_input_tokens": 3,
            "cache_creation_input_tokens": 1,
        }
    ) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "cache_read_input_tokens": 3,
        "cache_creation_input_tokens": 1,
        "reasoning_tokens": None,
    }


@pytest.mark.parametrize(
    "details,expected",
    [
        ({"cache_creation": 4}, 4),
        ({"cache_creation": 0, "ephemeral_5m_input_tokens": 4}, 4),
        ({"cache_creation": 0, "ephemeral_1h_input_tokens": 3}, 3),
        (
            {
                "cache_creation": 0,
                "ephemeral_5m_input_tokens": 4,
                "ephemeral_1h_input_tokens": 3,
            },
            7,
        ),
        ({"cache_creation": 2, "ephemeral_5m_input_tokens": 4}, 6),
        ({"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}, 0),
        ({}, None),
    ],
)
def test_langchain_cache_creation_includes_ttl_buckets(details, expected):
    """LangChain splits Anthropic cache writes into disjoint TTL buckets."""
    usage = normalize_langchain_usage(
        {
            "input_tokens": 20,
            "output_tokens": 5,
            "input_token_details": details,
        }
    )
    assert usage is not None
    assert usage["cache_creation_input_tokens"] == expected
    assert usage["input_tokens"] == 20
    assert usage["total_tokens"] == 25


def test_openai_prompt_and_completion_already_include_subsets():
    usage = normalize_provider_usage(
        {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 3},
            "completion_tokens_details": {"reasoning_tokens": 2},
        }
    )
    assert usage is not None
    assert usage["input_tokens"] == 10
    assert usage["output_tokens"] == 5
    assert usage["cache_read_input_tokens"] == 3
    assert usage["reasoning_tokens"] == 2


@pytest.mark.parametrize("tier", ["", "flex_", "priority_"])
@pytest.mark.parametrize("count", [3, 0, None])
def test_openai_service_tier_usage_preserves_subsets(tier, count, tmp_path):
    details = {} if count is None else {f"{tier}cache_read": count}
    creation = {} if count is None else {f"{tier}cache_creation": count}
    reasoning = {} if count is None else {f"{tier}reasoning": count}
    path = tmp_path / "trajectory.jsonl"
    TrajectoryWriter((path,)).write_messages(
        [
            {
                "role": "assistant",
                "content": "answer",
                "usage_metadata": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "input_token_details": {**details, **creation},
                    "output_token_details": reasoning,
                },
            }
        ]
    )
    usage = read_trajectory_messages(path)[0]["usage_metadata"]
    assert usage == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "cache_read_input_tokens": count,
        "cache_creation_input_tokens": count,
        "reasoning_tokens": count,
    }


def test_langchain_aggregated_service_tier_buckets_are_added_once():
    """Combined messages can retain disjoint detail counts from multiple tiers."""
    usage = normalize_langchain_usage(
        {
            "input_tokens": 30,
            "output_tokens": 20,
            "input_token_details": {
                "cache_read": 1,
                "flex_cache_read": 2,
                "priority_cache_read": 3,
                "flex_cache_creation": 4,
                "priority_cache_creation": 5,
                "flex": 10,
                "priority": 10,
            },
            "output_token_details": {
                "reasoning": 2,
                "flex_reasoning": 3,
                "priority_reasoning": 4,
                "flex": 6,
                "priority": 5,
            },
        }
    )
    assert usage is not None
    assert usage["cache_read_input_tokens"] == 6
    assert usage["cache_creation_input_tokens"] == 9
    assert usage["reasoning_tokens"] == 9
    assert usage["total_tokens"] == 50


def test_source_total_disagreement_warns_and_uses_normalized_components():
    with pytest.warns(RuntimeWarning, match="trajectory_source_total_mismatch"):
        usage = normalize_langchain_usage(
            {"input_tokens": 10, "output_tokens": 5, "total_tokens": 999}
        )
    assert usage is not None and usage["total_tokens"] == 15


@pytest.mark.parametrize("value", [True, -1, "5", 1.5, 9007199254740992])
def test_invalid_adapter_counts_stay_unknown(value):
    usage = normalize_langchain_usage({"input_tokens": value, "output_tokens": 2})
    assert usage is not None
    assert usage["input_tokens"] is None and usage["total_tokens"] is None


def test_zero_is_reported_and_source_total_alone_is_not_an_allocation():
    assert normalize_langchain_usage({"total_tokens": 10}) is None
    usage = normalize_langchain_usage(
        {"input_tokens": 0, "input_token_details": {"cache_read": 0}}
    )
    assert usage is not None
    assert usage["input_tokens"] == usage["cache_read_input_tokens"] == 0
    assert usage["output_tokens"] is None


def test_writer_owns_usage_conversion_and_preserves_raw_response_evidence(tmp_path):
    response = AIMessage(
        content="answer",
        response_metadata={
            "token_usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 3},
            }
        },
    )
    path = tmp_path / "trajectory.jsonl"
    TrajectoryWriter((path,)).write_messages([response])
    stored = read_trajectory_messages(path)[0]
    assert stored["usage_metadata"] == message_token_usage(response)
    assert stored["usage_metadata"]["cache_read_input_tokens"] == 3
    assert stored["response_metadata"] == response.response_metadata


@pytest.mark.parametrize(
    "raw",
    [
        {"input_tokens": 1, "input_token_details": {"cache_read": 2}},
        {"output_tokens": 1, "output_token_details": {"reasoning": 2}},
    ],
)
def test_producer_rejects_impossible_subsets(raw):
    with pytest.raises(ValueError):
        normalize_langchain_usage(raw)
