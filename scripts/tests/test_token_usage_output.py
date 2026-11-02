from scripts.token_usage import AttemptUsage, RunUsage, StageUsage
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
        cache_read_tokens=400,
        cache_creation_tokens=0,
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
