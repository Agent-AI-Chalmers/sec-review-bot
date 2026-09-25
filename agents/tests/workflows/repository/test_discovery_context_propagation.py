import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

import sec_review_agents.scan_stages.discovery.stage as discovery_stage
from sec_review_agents.agents.discovery.model import DiscoveryLocation
from sec_review_agents.runtime.transcripts import TranscriptWriter


def test_discovery_location_accepts_file_level_anchor() -> None:
    location = DiscoveryLocation(file="src/app.py", label="Relevant file")

    assert location.line is None
    assert location.file == "src/app.py"
    assert location.label == "Relevant file"


def test_discovery_location_label_schema_rejects_overlong_label() -> None:
    with pytest.raises(ValidationError):
        DiscoveryLocation(file="src/app.py", line=1, label="x" * 121)


def test_normalize_candidate_preserves_schema_valid_location_label() -> None:
    label = "Client-side addItem passes book.price without canonical price check"
    content = "const price = book.price;\naddItem({ price });\n"

    candidate = discovery_stage._normalize_candidate(
        {
            "src/components/AddToCartButton.tsx": {
                "path": "src/components/AddToCartButton.tsx"
            }
        },
        {"src/components/AddToCartButton.tsx": content},
        {
            "category": "business-logic",
            "description": "Price flows from client-side props into cart state.",
            "locations": [
                {
                    "file": "src/components/AddToCartButton.tsx",
                    "line": 2,
                    "label": label,
                }
            ],
            "evidence": ["addItem({ price });"],
        },
    )

    assert candidate is not None
    assert candidate["locations"][0]["label"] == label
    assert not {
        "fixabilityHint",
        "mitigationHandler",
        "priorityBoost",
        "groundingNotes",
        "discoverySource",
    }.intersection(candidate)


def test_normalize_candidate_preserves_file_level_location() -> None:
    content = "const price = book.price;\naddItem({ price });\n"

    candidate = discovery_stage._normalize_candidate(
        {
            "src/components/AddToCartButton.tsx": {
                "path": "src/components/AddToCartButton.tsx"
            }
        },
        {"src/components/AddToCartButton.tsx": content},
        {
            "category": "business-logic",
            "description": "Price flows from client-side props into cart state.",
            "locations": [
                {
                    "file": "src/components/AddToCartButton.tsx",
                    "label": "Cart component",
                }
            ],
            "evidence": ["addItem({ price });"],
        },
    )

    assert candidate is not None
    assert candidate["locations"][0] == {
        "file": "src/components/AddToCartButton.tsx",
        "label": "Cart component",
    }


def test_normalize_candidate_preserves_full_grounded_evidence() -> None:
    snippet = "const message = '" + ("x" * 450) + "';"
    content = f"{snippet}\n"

    candidate = discovery_stage._normalize_candidate(
        {"src/app.ts": {"path": "src/app.ts"}},
        {"src/app.ts": content},
        {
            "category": "information-disclosure",
            "description": "Long evidence remains intact when it is grounded.",
            "locations": [{"file": "src/app.ts", "line": 1, "label": "long evidence"}],
            "evidence": [snippet],
        },
    )

    assert candidate is not None
    assert candidate["evidence"] == [snippet]


@pytest.mark.asyncio
async def test_execute_discovery_raises_agent_runtime_errors() -> None:
    async def fake_invoke_agent_runtime_graph(**_kwargs):
        raise RuntimeError("missing structured response")

    with (
        patch(
            "sec_review_agents.scan_stages.discovery.execution.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.execution.create_repository_discovery_agent_graph",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.execution.build_repository_discovery_user_prompt",
            return_value="scan prompt",
        ),
        pytest.raises(RuntimeError, match="missing structured response"),
    ):
        await discovery_stage.execute_discovery(
            chunk={
                "chunk_id": "discovery-chunk-0001",
                "entries": [
                    {
                        "path": "src/app.py",
                        "language": "python",
                        "size_bytes": 12,
                    }
                ],
            },
            sources={"src/app.py": "print('ok')\n"},
        )


@pytest.mark.asyncio
async def test_execute_discovery_persists_chunk_message_history(
    tmp_path: Path,
) -> None:
    class FakeMessage:
        type = "ai"
        id = None
        name = None
        content = "chunk scan response"
        usage_metadata = None

        def __init__(self) -> None:
            self.additional_kwargs: dict[str, Any] = {}
            self.response_metadata: dict[str, Any] = {}
            self.tool_calls: list[dict[str, Any]] = []
            self.invalid_tool_calls: list[dict[str, Any]] = []
            self.tool_call_chunks: list[dict[str, Any]] = []

    async def fake_invoke_agent_runtime_graph(**kwargs):
        writer = TranscriptWriter(kwargs["transcript_paths"], agent_name="test")
        writer.write_messages([FakeMessage()])
        return {"candidates": []}

    artifact_root = tmp_path
    with (
        patch(
            "sec_review_agents.scan_stages.discovery.execution.invoke_agent_runtime_graph",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.execution.create_repository_discovery_agent_graph",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.execution.build_repository_discovery_user_prompt",
            return_value="scan prompt",
        ),
    ):
        await discovery_stage.execute_discovery(
            chunk={
                "chunk_id": "discovery-chunk-0001",
                "entries": [
                    {
                        "path": "src/app.py",
                        "language": "python",
                        "size_bytes": 12,
                    }
                ],
            },
            sources={"src/app.py": "print('ok')\n"},
            discovery_artifacts_path=artifact_root,
        )

    transcript_file = artifact_root / "transcripts" / "discovery-chunk-0001.json"
    messages = json.loads(transcript_file.read_text(encoding="utf-8"))
    assert messages[0]["content"] == "chunk scan response"


@pytest.mark.asyncio
async def test_scan_chunk_uses_current_trace_context(tmp_path: Path) -> None:
    root = tmp_path
    target = root / "src" / "app.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("print('ok')\n", encoding="utf-8")

    entry = {"path": "src/app.py", "language": "python", "size_bytes": 12}

    with patch(
        "sec_review_agents.scan_stages.discovery.stage.execute_discovery",
        new=AsyncMock(
            return_value={
                "candidates": [],
                "tokenUsages": [],
            }
        ),
    ):
        result = await discovery_stage.scan_discovery_chunk(
            chunk={
                "chunk_id": "discovery-chunk-0001",
                "entries": [entry],
                "token_count": 12,
            },
            root=root,
        )

    assert result["file_results"][0]["candidate_count"] == 0


def test_discovery_chunk_token_budget_uses_half_deployment_context() -> None:
    with patch(
        "sec_review_agents.scan_stages.discovery.stage.resolve_bound_deployment_max_input_tokens",
        return_value=200_001,
    ) as resolve_limit:
        target_tokens = discovery_stage.discovery_chunk_target_tokens()

    assert target_tokens == 100_000
    resolve_limit.assert_called_once_with("repository-discovery")


def test_discovery_chunk_packing_stops_before_target_overflow(tmp_path: Path) -> None:
    root = tmp_path
    files = {
        "src/a.py": "a" * 40,
        "src/b.py": "b" * 40,
        "src/c.py": "c" * 10,
    }
    for relative_path, content in files.items():
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    entries = [
        {
            "path": relative_path,
            "language": "python",
            "size_bytes": len(content),
            "include_reason": "text-candidate",
        }
        for relative_path, content in files.items()
    ]

    with patch(
        "sec_review_agents.scan_stages.discovery.stage._estimate_discovery_prompt_tokens",
        side_effect=lambda **kwargs: sum(
            int(entry["size_bytes"]) for entry in kwargs["entries"]
        ),
    ):
        chunks, skipped = discovery_stage._pack_discovery_chunks(
            entries=entries,
            root=root,
            target_tokens=50,
        )

    assert skipped == []
    assert [[entry["path"] for entry in chunk["entries"]] for chunk in chunks] == [
        ["src/a.py"],
        ["src/b.py", "src/c.py"],
    ]


def test_discovery_chunk_packing_skips_single_file_over_token_budget(
    tmp_path: Path,
) -> None:
    root = tmp_path
    path = root / "src" / "large.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x" * 100, encoding="utf-8")
    entries = [
        {
            "path": "src/large.py",
            "language": "python",
            "size_bytes": 100,
            "include_reason": "text-candidate",
        }
    ]

    with patch(
        "sec_review_agents.scan_stages.discovery.stage._estimate_discovery_prompt_tokens",
        return_value=101,
    ):
        chunks, skipped = discovery_stage._pack_discovery_chunks(
            entries=entries,
            root=root,
            target_tokens=100,
        )

    assert chunks == []
    assert skipped == [
        {
            "path": "src/large.py",
            "reason": "token-budget-exceeded",
            "size_bytes": 100,
            "token_count": 101,
            "target_tokens": 100,
        }
    ]
