import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

import sec_review_agents.scan_stages.discovery.stage as discovery_stage
from sec_review_agents.agents.discovery.model import (
    DiscoveryCandidate,
    DiscoveryLocation,
    DiscoveryOutput,
)
from sec_review_agents.runtime.trajectories import (
    TrajectoryWriter,
    read_trajectory_messages,
)
from sec_review_agents.scan_stages.discovery.input import (
    DiscoveryChunk,
    DiscoveryEntry,
    DiscoverySkippedFile,
)
from sec_review_agents.scan_stages.input import RepositoryScanScope


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
        {"src/components/AddToCartButton.tsx": content},
        DiscoveryCandidate.model_validate(
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
            }
        ),
    )

    assert candidate is not None
    assert candidate.locations[0].label == label
    assert not {
        "fixabilityHint",
        "mitigationHandler",
        "priorityBoost",
        "groundingNotes",
        "discoverySource",
    }.intersection(candidate.model_dump())


def test_normalize_candidate_preserves_file_level_location() -> None:
    content = "const price = book.price;\naddItem({ price });\n"

    candidate = discovery_stage._normalize_candidate(
        {"src/components/AddToCartButton.tsx": content},
        DiscoveryCandidate.model_validate(
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
            }
        ),
    )

    assert candidate is not None
    assert candidate.locations[0].model_dump(exclude_none=True) == {
        "file": "src/components/AddToCartButton.tsx",
        "label": "Cart component",
    }


def test_normalize_candidate_preserves_full_grounded_evidence() -> None:
    snippet = "const message = '" + ("x" * 450) + "';"
    content = f"{snippet}\n"

    candidate = discovery_stage._normalize_candidate(
        {"src/app.ts": content},
        DiscoveryCandidate.model_validate(
            {
                "category": "information-disclosure",
                "description": "Long evidence remains intact when it is grounded.",
                "locations": [
                    {"file": "src/app.ts", "line": 1, "label": "long evidence"}
                ],
                "evidence": [snippet],
            }
        ),
    )

    assert candidate is not None
    assert candidate.evidence == [snippet]


@pytest.mark.asyncio
async def test_execute_discovery_raises_agent_runtime_errors() -> None:
    async def fake_invoke_agent_runtime_graph(**_kwargs):
        raise RuntimeError("missing structured response")

    with (
        patch(
            "sec_review_agents.scan_stages.discovery.execution.run_discovery_agent",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.execution.build_repository_discovery_user_prompt",
            return_value="scan prompt",
        ),
        pytest.raises(RuntimeError, match="missing structured response"),
    ):
        await discovery_stage.run_repository_discovery_agent(
            chunk=DiscoveryChunk.model_validate(
                {
                    "chunk_id": "discovery-chunk-0001",
                    "token_count": 0,
                    "entries": [
                        {
                            "path": "src/app.py",
                            "language": "python",
                            "size_bytes": 12,
                            "include_reason": "text-candidate",
                        }
                    ],
                }
            ),
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
        writer = TrajectoryWriter(kwargs["trajectory_paths"])
        writer.write_messages([FakeMessage()])
        return DiscoveryOutput()

    artifact_root = tmp_path
    with (
        patch(
            "sec_review_agents.scan_stages.discovery.execution.run_discovery_agent",
            side_effect=fake_invoke_agent_runtime_graph,
        ),
        patch(
            "sec_review_agents.scan_stages.discovery.execution.build_repository_discovery_user_prompt",
            return_value="scan prompt",
        ),
    ):
        await discovery_stage.run_repository_discovery_agent(
            chunk=DiscoveryChunk.model_validate(
                {
                    "chunk_id": "discovery-chunk-0001",
                    "token_count": 0,
                    "entries": [
                        {
                            "path": "src/app.py",
                            "language": "python",
                            "size_bytes": 12,
                            "include_reason": "text-candidate",
                        }
                    ],
                }
            ),
            sources={"src/app.py": "print('ok')\n"},
            discovery_artifacts_path=artifact_root,
        )

    trajectory_file = artifact_root / "trajectories" / "discovery-chunk-0001.jsonl"
    messages = read_trajectory_messages(trajectory_file)
    assert messages[0]["content"] == "chunk scan response"


@pytest.mark.asyncio
async def test_scan_chunk_uses_current_trace_context(tmp_path: Path) -> None:
    root = tmp_path
    target = root / "src" / "app.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("print('ok')\n", encoding="utf-8")

    entry: DiscoveryEntry = DiscoveryEntry.model_validate(
        {
            "path": "src/app.py",
            "language": "python",
            "size_bytes": 12,
            "include_reason": "text-candidate",
        }
    )

    with patch(
        "sec_review_agents.scan_stages.discovery.stage.run_repository_discovery_agent",
        new=AsyncMock(
            return_value=DiscoveryOutput.model_validate(
                {
                    "candidates": [],
                    "tokenUsages": [],
                }
            )
        ),
    ):
        result = await discovery_stage.scan_discovery_chunk(
            chunk=DiscoveryChunk.model_validate(
                {
                    "chunk_id": "discovery-chunk-0001",
                    "entries": [entry],
                    "token_count": 12,
                }
            ),
            root=root,
        )

    assert result.file_results[0].candidate_count == 0


def test_discovery_chunk_token_limits_use_bound_deployment_context() -> None:
    with patch(
        "sec_review_agents.scan_stages.discovery.stage.resolve_bound_deployment_max_input_tokens",
        return_value=200_001,
    ) as resolve_limit:
        deployment_limit_tokens, target_tokens, hard_limit_tokens = (
            discovery_stage.discovery_chunk_token_limits()
        )

    assert deployment_limit_tokens == 200_001
    assert target_tokens == 40_000
    assert hard_limit_tokens == 160_000
    resolve_limit.assert_called_once_with("repository-discovery")


def test_discovery_artifacts_record_target_and_hard_token_limits(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    artifacts = tmp_path / "artifacts"
    workspace.mkdir()

    with patch.object(
        discovery_stage,
        "discovery_chunk_token_limits",
        return_value=(250_000, 50_000, 200_000),
    ):
        manifest = discovery_stage.prepare_discovery_chunks(
            workspace_root=workspace,
            scan_mode="full",
            scan_scope=RepositoryScanScope.model_validate(
                {"incremental_changed_files": [], "paths_ignore": []}
            ),
            discovery_artifacts_path=artifacts,
        )

    chunks_artifact = json.loads(
        (artifacts / "discovery-chunks.json").read_text(encoding="utf-8")
    )
    assert manifest.deployment_input_limit_tokens == 250_000
    assert manifest.chunk_target_tokens == 50_000
    assert manifest.chunk_target_ratio == "1/5"
    assert manifest.chunk_hard_limit_tokens == 200_000
    assert chunks_artifact["metadata"] == {
        "deployment_input_limit_tokens": 250_000,
        "chunk_target_tokens": 50_000,
        "chunk_target_ratio": "1/5",
        "chunk_hard_limit_tokens": 200_000,
        "chunk_strategy": "single-file",
    }

    result = discovery_stage.build_discovery_result_from_chunks(
        entries=[],
        skipped_files=[],
        chunks=[],
        chunk_results=[],
        scan_mode="full",
        deployment_input_limit_tokens=250_000,
        chunk_target_tokens=50_000,
        chunk_target_ratio="1/5",
        chunk_hard_limit_tokens=200_000,
        discovery_concurrency=1,
    )
    result_path = artifacts / "discovery-result.json"
    assert not result_path.exists()

    discovery_stage.persist_discovery_result(
        discovery_artifacts_path=artifacts,
        result=result,
    )
    assert json.loads(result_path.read_text(encoding="utf-8")) == result.model_dump(
        mode="json", exclude_none=True
    )
    assert result.metadata.discovery_deployment_input_limit_tokens == 250_000
    assert result.metadata.discovery_chunk_target_tokens == 50_000
    assert result.metadata.discovery_chunk_target_ratio == "1/5"
    assert result.metadata.discovery_chunk_hard_limit_tokens == 200_000


def test_discovery_chunk_token_budget_rejects_limit_below_system_prompt() -> None:
    """Reject a deployment limit that would silently skip every source file."""
    with (
        patch(
            "sec_review_agents.scan_stages.discovery.stage.resolve_bound_deployment_max_input_tokens",
            return_value=10,
        ),
        pytest.raises(ValueError, match="exceed the discovery system prompt size"),
    ):
        discovery_stage.discovery_chunk_token_limits()


def test_discovery_chunk_token_limits_accept_experiment_ratio() -> None:
    with patch(
        "sec_review_agents.scan_stages.discovery.stage.resolve_bound_deployment_max_input_tokens",
        return_value=300_000,
    ):
        deployment_limit, target, hard_limit = (
            discovery_stage.discovery_chunk_token_limits((1, 3))
        )

    assert (deployment_limit, target, hard_limit) == (300_000, 100_000, 240_000)


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

    entries: list[DiscoveryEntry] = [
        DiscoveryEntry.model_validate(
            {
                "path": relative_path,
                "language": "python",
                "size_bytes": len(content),
                "include_reason": "text-candidate",
            }
        )
        for relative_path, content in files.items()
    ]

    with patch(
        "sec_review_agents.scan_stages.discovery.stage._estimate_discovery_prompt_tokens",
        side_effect=lambda **kwargs: sum(
            int(entry.size_bytes) for entry in kwargs["entries"]
        ),
    ):
        chunks, skipped = discovery_stage._pack_discovery_chunks(
            entries=entries,
            root=root,
            target_tokens=50,
            hard_limit_tokens=250,
            strategy="batched",
        )

    assert skipped == []
    assert [[entry.path for entry in chunk.entries] for chunk in chunks] == [
        ["src/a.py"],
        ["src/b.py", "src/c.py"],
    ]


def test_discovery_chunk_packing_keeps_single_file_over_target(
    tmp_path: Path,
) -> None:
    root = tmp_path
    path = root / "src" / "large.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x" * 100, encoding="utf-8")
    entries: list[DiscoveryEntry] = [
        DiscoveryEntry.model_validate(
            {
                "path": "src/large.py",
                "language": "python",
                "size_bytes": 100,
                "include_reason": "text-candidate",
            }
        )
    ]

    with patch(
        "sec_review_agents.scan_stages.discovery.stage._estimate_discovery_prompt_tokens",
        return_value=101,
    ):
        chunks, skipped = discovery_stage._pack_discovery_chunks(
            entries=entries,
            root=root,
            target_tokens=100,
            hard_limit_tokens=500,
        )

    assert skipped == []
    assert [[entry.path for entry in chunk.entries] for chunk in chunks] == [
        ["src/large.py"]
    ]


def test_discovery_chunk_packing_skips_single_file_over_hard_limit(
    tmp_path: Path,
) -> None:
    root = tmp_path
    path = root / "src" / "large.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x" * 100, encoding="utf-8")
    entries: list[DiscoveryEntry] = [
        DiscoveryEntry.model_validate(
            {
                "path": "src/large.py",
                "language": "python",
                "size_bytes": 100,
                "include_reason": "text-candidate",
            }
        )
    ]

    with patch(
        "sec_review_agents.scan_stages.discovery.stage._estimate_discovery_prompt_tokens",
        return_value=501,
    ):
        chunks, skipped = discovery_stage._pack_discovery_chunks(
            entries=entries,
            root=root,
            target_tokens=100,
            hard_limit_tokens=500,
        )

    assert chunks == []
    assert skipped == [
        DiscoverySkippedFile.model_validate(
            {
                "path": "src/large.py",
                "reason": "token-budget-exceeded",
                "size_bytes": 100,
                "token_count": 501,
                "hard_limit_tokens": 500,
            }
        )
    ]


def test_filtering_preserves_candidate_type_and_original_evidence() -> None:
    """The model requires evidence, but triage may receive a filtered empty list."""
    from sec_review_agents.agents.discovery.model import DiscoveryCandidate

    proposal = DiscoveryCandidate(
        category="example",
        description="An unverified claim",
        locations=[DiscoveryLocation(file="app.py", label="call")],
        evidence=["not in the source"],
    )
    original = proposal.model_dump()
    candidate = discovery_stage._normalize_candidate(
        {"app.py": "print('ok')\n"},
        proposal,
    )
    assert candidate is not None
    assert type(candidate) is type(proposal)
    assert proposal.model_dump() == original
    assert candidate.evidence == []
    assert [
        location.model_dump(exclude_none=True) for location in candidate.locations
    ] == [{"file": "app.py", "label": "call"}]


@pytest.mark.parametrize("evidence", [["execute(query)"], ["missing snippet"]])
def test_normalize_candidate_recovers_location_or_discards_candidate(evidence) -> None:
    candidate = DiscoveryCandidate(
        category="injection",
        description="Untrusted query",
        locations=[DiscoveryLocation(file="missing.py", line=99, label="query")],
        evidence=evidence,
    )
    original = candidate.model_dump()
    result = discovery_stage._normalize_candidate(
        {"app.py": "# query\nexecute(query)\n"}, candidate
    )
    assert candidate.model_dump() == original
    if evidence == ["missing snippet"]:
        assert result is None
    else:
        assert result is not None
        assert result.locations == [
            DiscoveryLocation(file="app.py", line=2, label="execute(query)")
        ]
        assert result.evidence == evidence
