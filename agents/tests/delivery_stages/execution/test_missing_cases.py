from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.delivery_stages.execution.input import DeliveryPatchCase
from sec_review_agents.delivery_stages.execution.stage import execute_delivery_entry
from sec_review_agents.delivery_stages.model import DeliveryEntry
from sec_review_agents.delivery_stages.result import build_delivery_result_from_outcomes


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "strategy,case_ids",
    [
        ("single", ["missing"]),
        ("combined", ["a", "missing"]),
        ("combined", ["missing"]),
    ],
)
async def test_incomplete_delivery_fails_without_synthesis(
    monkeypatch, tmp_path: Path, strategy, case_ids
):
    synthesize = AsyncMock()
    monkeypatch.setattr(
        "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
        synthesize,
    )
    entry = DeliveryEntry(
        delivery_id="delivery",
        strategy=strategy,
        case_ids=case_ids,
        reason="planned together",
    )
    outcome = await execute_delivery_entry(
        run_artifacts_root=tmp_path,
        delivery_entry=entry,
        case_results=[
            DeliveryPatchCase(
                case_id="a",
                mitigator_file_changes=[{"path": "a", "status": "deleted"}],
                mitigator_patch_diff="patch",
            )
        ],
    )
    assert outcome is not None
    assert outcome.status == "failed"
    assert "missing" in (outcome.error or "")
    assert outcome.file_changes == []
    synthesize.assert_not_awaited()
    result = build_delivery_result_from_outcomes(
        deliveries=[entry], keep_case_ids=case_ids, patch_outcomes=[outcome]
    )
    assert result.deliveries == []
