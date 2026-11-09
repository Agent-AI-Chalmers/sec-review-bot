import pytest
from scripts.execution_statistics.langfuse_run import aggregate_run


def snapshot(calls):
    return aggregate_run(
        run_id="run", generations=calls, root_count=1, excluded_non_review_root_count=0
    )


def test_partial_call_usage_does_not_become_complete_total():
    result = snapshot(
        [
            {
                "model": "reported",
                "usageDetails": {"input": 10, "output": 3, "total": 13},
            },
            {"model": "missing"},
        ]
    )
    assert result["observed_usage_coverage"] == "partial"
    assert all(value is None for value in result["token_usage"].values())
    groups = {group["model"]: group for group in result["groups"]}
    assert groups["reported"]["token_usage"]["input_tokens"] == 10
    assert groups["missing"]["token_usage"]["input_tokens"] is None
    assert groups["reported"]["token_usage"]["cache_read_input_tokens"] is None


def test_totals_keep_explicit_zero_and_require_each_field_from_each_call():
    result = snapshot(
        [
            {"usageDetails": {"input": 0, "output": 3, "total": 3, "reasoning": 0}},
            {"usageDetails": {"input": 0, "output": 2, "reasoning": 0}},
        ]
    )
    assert result["token_usage"]["input_tokens"] == 0
    assert result["token_usage"]["output_tokens"] == 5
    assert result["token_usage"]["reasoning_tokens"] == 0
    # The total is derived from the normalized components, not taken from the source.
    assert result["token_usage"]["total_tokens"] == 5
    assert result["groups"][0]["token_usage"] == result["token_usage"]


@pytest.mark.parametrize("value", [True, -1, "5"])
def test_malformed_token_counts_are_not_reported(value):
    result = snapshot([{"usageDetails": {"input": value}}])
    assert result["usage_reported_call_count"] == 0
    assert result["token_usage"]["input_tokens"] is None


def test_no_calls_has_no_measured_totals():
    result = snapshot([])
    assert all(value is None for value in result["token_usage"].values())


def test_normalized_langfuse_and_trajectory_usage_use_the_same_vocabulary():
    from sec_review_agents.runtime.token_usage import normalize_langchain_usage

    call = {
        "usageDetails": {
            "input": 6,
            "output": 3,
            "total": 15,
            "cache_read_input_tokens": 3,
            "cache_creation_input_tokens": 1,
            "reasoning": 2,
        }
    }
    normalized = normalize_langchain_usage(
        {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "input_token_details": {"cache_read": 3, "cache_creation": 1},
            "output_token_details": {"reasoning": 2},
        }
    )
    assert snapshot([call])["token_usage"] == normalized
