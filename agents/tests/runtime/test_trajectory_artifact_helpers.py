import json

from tests.runtime.trajectory_artifact_helpers import (
    tool_interactions_from_trajectory,
)


def _write_messages(trajectory, messages: list[dict]) -> None:
    trajectory.write_text(
        "\n".join(
            json.dumps({"seq": index, "event": "message", "message": message})
            for index, message in enumerate(messages, start=1)
        )
        + "\n",
        encoding="utf-8",
    )


def test_tool_interactions_pair_same_named_calls_with_their_results(tmp_path) -> None:
    trajectory = tmp_path / "trajectory.jsonl"
    _write_messages(
        trajectory,
        [
            {
                "type": "ai",
                "tool_calls": [
                    {
                        "id": "call-first",
                        "name": "playwright_browser_navigate",
                        "args": {"url": "https://example.test/first"},
                    },
                    {
                        "id": "call-second",
                        "name": "playwright_browser_navigate",
                        "args": {"url": "https://example.test/second"},
                    },
                ],
            },
            {
                "type": "tool",
                "tool_call_id": "call-second",
                "name": "playwright_browser_navigate",
                "content": "second result",
            },
            {
                "type": "tool",
                "tool_call_id": "call-first",
                "name": "playwright_browser_navigate",
                "content": "first result",
            },
        ],
    )

    assert tool_interactions_from_trajectory(trajectory) == [
        {
            "tool": "playwright_browser_navigate",
            "arguments": {"url": "https://example.test/second"},
            "result": "second result",
        },
        {
            "tool": "playwright_browser_navigate",
            "arguments": {"url": "https://example.test/first"},
            "result": "first result",
        },
    ]


def test_tool_interactions_ignore_calls_without_stable_ids(tmp_path) -> None:
    trajectory = tmp_path / "trajectory.jsonl"
    _write_messages(
        trajectory,
        [
            {
                "type": "ai",
                "tool_calls": [
                    {
                        "name": "playwright_browser_navigate",
                        "args": {"url": "https://example.test"},
                    }
                ],
            },
            {
                "type": "tool",
                "name": "playwright_browser_navigate",
                "content": "unattributed result",
            },
        ],
    )

    assert tool_interactions_from_trajectory(trajectory) == []
