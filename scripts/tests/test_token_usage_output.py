from scripts.token_usage.models import AttemptUsage, RunUsage, StageUsage
from scripts.token_usage.output import (
    render_csv,
    render_json,
    render_raw_text,
    render_table,
)


def _run() -> RunUsage:
    stage = StageUsage(
        stage="single-agent",
        model_id="deepseek/deepseek-v4-pro",
        input_tokens=1_000,
        output_tokens=200,
        total_tokens=1_200,
        cache_read_input_tokens=400,
        cache_creation_input_tokens=0,
        reasoning_tokens=50,
        ai_message_count=2,
        ai_messages_with_usage_count=2,
    )
    return RunUsage(
        run_dir="/tmp/run-x",
        experiment="demo",
        workflow_kind=None,
        retry_count_used=0,
        stages=[stage],
        attempts=[
            AttemptUsage(stage="single-agent", attempt_label="initial", usage=stage)
        ],
    )


def test_reports_never_emit_cost_or_pricing():
    """Cost is a deliberate non-goal; no renderer may reintroduce a price field."""
    run = _run()
    for text in (
        render_table([run]),
        render_json([run]),
        render_csv([run]),
        render_raw_text([run]),
    ):
        lowered = text.lower()
        assert "cost" not in lowered
        assert "pricing" not in lowered
        assert "deepseek/deepseek-v4-pro" in text


def test_unknown_usage_renders_without_fabricating_zero():
    import json
    from dataclasses import replace

    run = _run()
    stage = replace(
        run.stages[0],
        input_tokens=None,
        total_tokens=None,
        cache_read_input_tokens=None,
    )
    run = replace(run, stages=[stage], attempts=[])
    payload = json.loads(render_json([run]))[0]
    assert payload["input_tokens"] is None
    assert payload["cache_read_input_tokens"] is None
    assert payload["cache_ratio"] is None
    assert "unknown" in render_table([run])
    assert "input=unknown" in render_raw_text([run])
    assert render_csv([run])


def test_machine_readable_reports_include_every_canonical_token_field():
    import csv
    import io
    import json

    from sec_review_agents.runtime.token_usage import TOKEN_FIELDS

    run = _run()
    payload = json.loads(render_json([run]))[0]
    row = next(csv.DictReader(io.StringIO(render_csv([run]))))
    for field in TOKEN_FIELDS:
        assert field in payload
        assert field in payload["effective_patch"]
        assert field in row
    assert payload["reasoning_tokens"] == 50
    assert row["reasoning_tokens"] == "50"
