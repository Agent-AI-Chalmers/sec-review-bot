"""Keep inspectable runtime recordings usable by trajectory and Memory consumers."""

from shutil import copyfile

import pytest
from deepagents.backends import FilesystemBackend

from sec_review_agents.agents.memory_extractor.tools import build_trajectory_tools
from sec_review_agents.runtime.trajectories import (
    read_trajectory_events,
    read_trajectory_messages,
)
from tests.contract_fixtures import transcript_corpus_file


@pytest.mark.parametrize(
    ("filename", "message_count", "call_count", "total_tokens"),
    [("subagents.jsonl", 17, 6, 4868), ("summarization.jsonl", 11, 4, 4105)],
)
def test_recorded_trajectory_is_complete_and_readable_by_memory(
    tmp_path, filename, message_count, call_count, total_tokens
):
    path = transcript_corpus_file(filename)
    events = read_trajectory_events(path)
    messages = read_trajectory_messages(path)
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert len(messages) == message_count
    by_id = {message["id"]: message for message in messages}
    assert len(by_id) == len(messages)
    systems = [
        e
        for e in events
        if e["event"] == "message" and e["message"]["role"] == "system"
    ]
    assert sum(e["agent"] == "issue-analyzer" for e in systems) == 1
    assert all(e["run_id"] and e["parent_ids"] for e in systems)
    starts = {e["call_id"] for e in events if e["event"] == "model_call_start"}
    ends = [e for e in events if e["event"] == "model_call_end"]
    generated = {
        e["call_id"]: e for e in events if e["event"] == "message" and e.get("call_id")
    }
    assert len(starts) == len(ends) == len(generated) == call_count
    assert {e["call_id"] for e in ends} == starts == generated.keys()
    for end in ends:
        assert generated[end["call_id"]]["message"]["id"] == end["message_id"]
        assert end["message_id"] in by_id
    assert (
        sum(
            m["usage_metadata"]["total_tokens"]
            for m in by_id.values()
            if m.get("usage_metadata")
        )
        == total_tokens
    )
    requests = {call["id"] for m in messages for call in m.get("tool_calls", [])}
    results = [m["tool_call_id"] for m in messages if m["role"] == "tool"]
    assert len(results) == len(set(results))
    assert requests == set(results)
    assert events[-1] == {
        "seq": len(events),
        "event": "model_calls_end",
        "status": "completed",
    }

    directory = tmp_path / "trajectories"
    directory.mkdir()
    copyfile(path, directory / filename)
    tools = {
        tool.name: tool
        for tool in build_trajectory_tools(
            FilesystemBackend(root_dir=tmp_path, virtual_mode=True)
        )
    }
    listing = tools["list_trajectory_messages"].invoke(
        {"file_path": f"/trajectories/{filename}"}
    )
    assert listing["ok"] and not listing["parse_errors"]
    assert len(listing["messages"]) == message_count
    assert {item["id"] for item in listing["messages"]} == by_id.keys()
    if filename == "summarization.jsonl":
        assert [
            m["role"] for m in listing["messages"] if m["source"] == "summarization"
        ] == ["user", "assistant", "user"]
    for record in generated.values():
        result = tools["read_trajectory_message"].invoke(
            {"file_path": f"/trajectories/{filename}", "seq": record["seq"]}
        )
        assert result["ok"]
        assert result["message"] == record["message"]
        assert result["call_id"] == record["call_id"]
        assert result["parent_ids"] == record["parent_ids"]


def test_subagent_fixture_preserves_delegation_and_independent_branches():
    events = read_trajectory_events(transcript_corpus_file("subagents.jsonl"))
    generated = [e for e in events if e["event"] == "message" and e.get("call_id")]
    parent = generated[0]
    assert {c["args"]["subagent_type"] for c in parent["message"]["tool_calls"]} == {
        "source-reviewer",
        "test-reviewer",
    }
    branches = {}
    for agent in ("source-reviewer", "test-reviewer"):
        child = [e for e in generated if e.get("agent") == agent]
        assert len(child) == 2
        assert child[0]["message"]["tool_calls"][0]["name"] == "read_file"
        branches[agent] = child[0]["parent_ids"]
        assert child[-1]["message"]["content"]
        assert parent["parent_ids"][0] == child[0]["parent_ids"][0]
    assert branches["source-reviewer"] != branches["test-reviewer"]
    systems = [
        e
        for e in events
        if e["event"] == "message" and e["message"]["role"] == "system"
    ]
    child_systems = [e for e in systems if e["agent"] != "issue-analyzer"]
    assert {e["agent"] for e in child_systems} == {
        "source-reviewer",
        "test-reviewer",
    }
    assert (
        child_systems[0]["message"]["content"] == child_systems[1]["message"]["content"]
    )
    final = generated[-1]["message"]["tool_calls"][0]
    assert final["name"] == "ReviewResult"
    assert final["args"]["verdict"] == "vulnerable"


def test_summarization_fixture_keeps_response_context_and_original_evidence():
    events = read_trajectory_events(transcript_corpus_file("summarization.jsonl"))
    summary = next(
        e
        for e in events
        if e["event"] == "message"
        and e.get("source") == "summarization"
        and e.get("call_id")
    )
    assert summary["message"]["role"] == "assistant"
    assert summary["message"]["usage_metadata"]["total_tokens"] == 1275
    context = next(
        e
        for e in events
        if e["event"] == "message"
        and e["message"]["role"] == "user"
        and summary["message"]["content"] in e["message"]["content"]
    )
    assert context["seq"] > summary["seq"]
    assert "call_id" not in context
    source = next(
        e
        for e in events
        if e["event"] == "message"
        and e["message"].get("tool_call_id") == "call_read_source"
    )
    assert source["seq"] < summary["seq"]
    assert "target = Path(root) / requested" in source["message"]["content"]
    assert any(
        e["event"] == "model_call_start" and e["seq"] > context["seq"] for e in events
    )


def test_fixture_seq_preserves_each_agents_conversation_order():
    for filename in ("subagents.jsonl", "summarization.jsonl"):
        events = read_trajectory_events(transcript_corpus_file(filename))
        records = [e for e in events if e["event"] == "message"]
        assert records[0]["message"]["role"] == "system"
        assert records[1]["message"]["role"] == "user"
        agents = {e.get("agent") for e in records}
        for agent in agents - {None}:
            branch = [
                e
                for e in records
                if e.get("agent") == agent and e.get("source") != "summarization"
            ]
            assert branch[0]["message"]["role"] == "system"
            assert branch[1]["message"]["role"] == "user"
            assert branch[0]["seq"] < branch[1]["seq"]
        if filename == "summarization.jsonl":
            summary = [e for e in records if e.get("source") == "summarization"]
            assert [e["message"]["role"] for e in summary] == [
                "user",
                "assistant",
                "user",
            ]
            assert "summary" in summary[0]["message"]["content"].lower()
            assert "src/download.py" in summary[0]["message"]["content"]


def test_transcript_contract_corpus():
    from tests.contract_fixtures import transcript_corpus_manifest

    manifest = transcript_corpus_manifest()
    for name in manifest["valid"]:
        read_trajectory_events(transcript_corpus_file(name))
    for name in manifest["invalid"]:
        with pytest.raises(ValueError):
            read_trajectory_events(transcript_corpus_file(name))


def test_transcript_records_match_contract_schema():
    import json

    from jsonschema import Draft202012Validator

    from tests.contract_fixtures import (
        AGENT_TRANSCRIPT_ROOT,
        transcript_corpus_manifest,
    )

    schema = json.loads(
        (AGENT_TRANSCRIPT_ROOT / "schemas/record.schema.json").read_text()
    )
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    for name in transcript_corpus_manifest()["valid"]:
        for event in read_trajectory_events(transcript_corpus_file(name)):
            validator.validate(event)
