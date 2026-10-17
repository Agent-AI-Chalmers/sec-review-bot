import json

from tests.llm.transcript_artifact_helpers import (
    tool_interactions_from_transcript,
)


def test_tool_interactions_pair_same_named_calls_with_their_results(tmp_path) -> None:
    transcript = tmp_path / "transcript.json"
    transcript.write_text(
        json.dumps(
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
            ]
        ),
        encoding="utf-8",
    )

    assert tool_interactions_from_transcript(transcript) == [
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
    transcript = tmp_path / "transcript.json"
    transcript.write_text(
        json.dumps(
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
            ]
        ),
        encoding="utf-8",
    )

    assert tool_interactions_from_transcript(transcript) == []
