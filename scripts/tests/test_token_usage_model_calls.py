import json

import pytest
from scripts.token_usage.loading import _read_trajectory_usage
from scripts.token_usage.models import aggregate_stage_usages


def artifact(tmp_path, *, usage=True, finish=True, end=True):
    response = {
        "id": "reply",
        "role": "assistant",
        "content": "reply",
        "usage_metadata": (
            {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}
            if usage
            else None
        ),
    }
    events = [
        {"event": "model_calls_start", "version": 1},
        {"event": "model_call_start", "call_id": "one"},
    ]
    if end:
        events.extend(
            [
                {"event": "message", "call_id": "one", "message": response},
                {"event": "model_call_end", "call_id": "one", "message_id": "reply"},
            ]
        )
    if finish:
        events.append({"event": "model_calls_end", "status": "completed"})
    path = tmp_path / "trajectory.jsonl"
    for seq, event in enumerate(events, 1):
        event["seq"] = seq
    path.write_text("".join(json.dumps(e) + "\n" for e in events))
    return path


def test_call_usage_is_not_added_to_conversation_usage(tmp_path):
    usage = _read_trajectory_usage(artifact(tmp_path), stage="analyzer")
    assert usage.total_tokens == 12
    assert usage.model_call_count == usage.model_calls_with_usage_count == 1
    assert usage.usage_complete
    assert aggregate_stage_usages([usage]).usage_complete


@pytest.mark.parametrize(
    "options", [{"usage": False}, {"finish": False}, {"end": False}]
)
def test_missing_usage_or_terminal_events_never_claim_complete(tmp_path, options):
    usage = _read_trajectory_usage(artifact(tmp_path, **options), stage="analyzer")
    assert not usage.usage_complete
    assert usage.usage_source == "model-calls"
    assert usage.total_tokens == (12 if options == {"finish": False} else 0)


def test_message_only_transcripts_have_limited_coverage(tmp_path):
    path = artifact(tmp_path)
    events = [
        e
        for e in map(json.loads, path.read_text().splitlines())
        if e["event"] == "message"
    ]
    for seq, event in enumerate(events, 1):
        event["seq"] = seq
    path.write_text("".join(json.dumps(e) + "\n" for e in events))
    usage = _read_trajectory_usage(path, stage="analyzer")
    assert usage.total_tokens == 12
    assert usage.usage_source == "trajectory"
    assert not usage.usage_complete


@pytest.mark.parametrize("corruption", ["duplicate", "unmatched", "truncated"])
def test_broken_call_records_do_not_silently_fall_back(tmp_path, corruption):
    path = artifact(tmp_path)
    lines = path.read_text().splitlines()
    if corruption == "duplicate":
        lines.insert(-1, lines[-2])
    elif corruption == "unmatched":
        lines.pop(1)
    else:
        lines.append('{"event":')
    path.write_text("\n".join(lines))
    with pytest.raises(ValueError):
        _read_trajectory_usage(path, stage="analyzer")


def test_partial_metadata_is_known_usage_but_not_complete(tmp_path):
    path = artifact(tmp_path)
    events = list(map(json.loads, path.read_text().splitlines()))
    events[-3]["message"]["usage_metadata"].pop("output_tokens")
    path.write_text("\n".join(map(json.dumps, events)))
    usage = _read_trajectory_usage(path, stage="analyzer")
    assert usage.input_tokens == 10
    assert not usage.usage_complete


def test_response_saved_before_crash_keeps_known_usage(tmp_path):
    path = artifact(tmp_path)
    events = list(map(json.loads, path.read_text().splitlines()))[:-2]
    path.write_text("\n".join(map(json.dumps, events)))
    usage = _read_trajectory_usage(path, stage="analyzer")
    assert usage.total_tokens == 12
    assert not usage.usage_complete
