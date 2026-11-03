import json

import pytest
from scripts.token_usage.effective import compute_effective_patch_usage
from scripts.token_usage.loading import load_run_usage


def write_trajectory(path, model="current", *, usage=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {"event": "model_calls_start"},
        {
            "event": "message",
            "message": {
                "id": "history",
                "role": "assistant",
                "content": "Earlier context",
                "response_metadata": {"model_name": "historical"},
            },
        },
        {"event": "model_call_start", "call_id": "call"},
        {
            "event": "message",
            "call_id": "call",
            "message": {
                "id": "reply",
                "role": "assistant",
                "content": "Reply",
                "response_metadata": {"model_name": model} if model else {},
                "usage_metadata": (
                    {
                        "input_tokens": 10,
                        "output_tokens": 2,
                        "total_tokens": 12,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                        "reasoning_tokens": 0,
                    }
                    if usage
                    else None
                ),
            },
        },
        {"event": "model_call_end", "call_id": "call", "message_id": "reply"},
        {"event": "model_calls_end", "status": "completed"},
    ]
    path.write_text(
        "\n".join(
            json.dumps({"seq": seq, **record}) for seq, record in enumerate(records, 1)
        )
    )


@pytest.mark.parametrize(
    "model,usage,expected", [(None, True, "unknown"), ("current", False, "current")]
)
def test_model_attribution_uses_selected_response_without_history_fallback(
    tmp_path, model, usage, expected
):
    write_trajectory(tmp_path / "analyzer/trajectory.jsonl", model, usage=usage)
    run = load_run_usage(tmp_path)
    assert run.stages[0].model_id == expected
    assert run.total_tokens == (12 if usage else None)


def test_loader_excludes_published_copies_and_sorts_retry_attempts(tmp_path):
    for name in ("retry-2", "initial", "retry-1"):
        write_trajectory(tmp_path / f"mitigator/trajectories/{name}.jsonl")
    write_trajectory(tmp_path / "trajectories/0001-mitigator-initial.jsonl")
    run = load_run_usage(tmp_path)
    assert [attempt.attempt_label for attempt in run.attempts] == [
        "initial",
        "retry-1",
        "retry-2",
    ]
    assert run.total_tokens == 36
    assert run.retry_count_used == 2


@pytest.mark.parametrize(
    "result,stages,selected",
    [
        (
            "issue-review.single-agent-result.json",
            ["single-agent", "analyzer"],
            ["single-agent"],
        ),
        (
            "issue-review.two-stage-result.json",
            ["analyzer", "mitigator", "verifier"],
            ["analyzer", "mitigator"],
        ),
        (
            "repository-review-result.json",
            ["discovery", "analyzer", "verifier"],
            ["analyzer", "discovery", "verifier"],
        ),
    ],
)
def test_effective_patch_selects_real_attempts_for_maintained_workflows(
    tmp_path, result, stages, selected
):
    (tmp_path / result).write_text("{}")
    for stage in stages:
        write_trajectory(tmp_path / stage / "trajectory.jsonl")
    run = load_run_usage(tmp_path)
    effective = compute_effective_patch_usage(run)
    assert [attempt.stage for attempt in effective.included_attempts] == selected
    assert all(attempt in run.attempts for attempt in effective.included_attempts)
    assert effective.totals.total_tokens == len(selected) * 12


def test_two_stage_effective_patch_retains_every_model_group(tmp_path):
    """A stage may use different models across attempts; no group may disappear."""
    (tmp_path / "issue-review.two-stage-result.json").write_text("{}")
    write_trajectory(tmp_path / "analyzer/trajectory.jsonl")
    write_trajectory(tmp_path / "mitigator/trajectories/initial.jsonl", "first")
    write_trajectory(tmp_path / "mitigator/trajectories/retry-1.jsonl", "second")
    run = load_run_usage(tmp_path)
    assert len(run.stages) == 3
    effective = compute_effective_patch_usage(run)
    assert effective.totals.total_tokens == run.total_tokens == 36
    assert [a.attempt_label for a in effective.included_attempts] == [
        "initial",
        "initial",
        "retry-1",
    ]


def test_feedback_patch_path_excludes_final_verification(tmp_path):
    write_trajectory(tmp_path / "analyzer/trajectory.jsonl")
    for stage in ("mitigator", "verifier"):
        for attempt in ("initial", "retry-1"):
            write_trajectory(tmp_path / stage / "trajectories" / f"{attempt}.jsonl")
    effective = compute_effective_patch_usage(load_run_usage(tmp_path))
    assert [(a.stage, a.attempt_label) for a in effective.included_attempts] == [
        ("analyzer", "initial"),
        ("mitigator", "initial"),
        ("mitigator", "retry-1"),
        ("verifier", "initial"),
    ]
    assert effective.totals.total_tokens == 48


def test_lightweight_experiment_entrypoints_preserve_first_mitigation_scope(tmp_path):
    from scripts.token_usage import (
        compute_lightweight_two_stage_usage,
        lightweight_two_stage_run,
    )

    write_trajectory(tmp_path / "analyzer/trajectory.jsonl")
    for stage in ("mitigator", "verifier"):
        for attempt in ("initial", "retry-1"):
            write_trajectory(tmp_path / stage / "trajectories" / f"{attempt}.jsonl")
    run = load_run_usage(tmp_path)
    effective = compute_lightweight_two_stage_usage(run)
    assert [(a.stage, a.attempt_label) for a in effective.included_attempts] == [
        ("analyzer", "final"),
        ("mitigator", "initial"),
    ]
    assert effective.totals.total_tokens == 24
    projected = lightweight_two_stage_run(run)
    assert projected.total_tokens == 24
    assert projected.attempts == effective.included_attempts
    assert projected.run_dir == run.run_dir


def test_effective_experiment_projection_preserves_unknown_usage(tmp_path):
    from scripts.token_usage import effective_patch_run

    write_trajectory(tmp_path / "analyzer/trajectory.jsonl")
    write_trajectory(tmp_path / "mitigator/trajectory.jsonl", usage=False)
    projected = effective_patch_run(load_run_usage(tmp_path))
    assert len(projected.attempts) == 2
    assert projected.total_tokens is None
    assert not projected.totals.usage_complete
