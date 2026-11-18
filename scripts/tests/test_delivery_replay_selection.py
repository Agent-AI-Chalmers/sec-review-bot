import argparse
import json
from pathlib import Path
from types import ModuleType

import pytest
from pydantic import ValidationError
from scripts.replay import delivery_execution, delivery_planning


@pytest.mark.asyncio
@pytest.mark.parametrize("replay", [delivery_planning, delivery_execution])
@pytest.mark.parametrize("scenario", ["mixed", "blocked", "invalid-blocked"])
async def test_delivery_replay_validates_cases_before_shared_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replay: ModuleType, scenario: str
) -> None:
    """Replay validates every stored case before applying the normal delivery rule."""
    cases = [
        {"case_id": "blocked", "deliverable": False, "review_record": {}},
    ]
    if scenario != "blocked":
        cases.append(
            {
                "case_id": "approved",
                "deliverable": True,
                "review_record": {
                    "mitigation": {
                        "overview": "Approved repair",
                        "file_changes": [{"path": "unsafe.py", "status": "deleted"}],
                    }
                },
            }
        )
    if scenario == "invalid-blocked":
        del cases[0]["case_id"]
    input_path = tmp_path / "input.json"
    input_path.write_text("{}")
    (tmp_path / "repository-review-result.json").write_text(
        json.dumps({"case_results": cases})
    )
    plan_root = tmp_path / "delivery-planning"
    plan_root.mkdir()
    (plan_root / "delivery-plan.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "metadata": {
                    "planning_mode": "single",
                    "agent_run_count": 1,
                    "batch_size": None,
                },
                "counts": {"input_case_count": 1, "delivery_count": 1},
                "deliveries": [
                    {
                        "delivery_id": "delivery",
                        "strategy": "single",
                        "case_ids": ["approved"],
                        "reason": "Approved repair",
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(replay, "bootstrap_agents_env", lambda: None)
    monkeypatch.setattr(
        replay,
        "_parse_args",
        lambda: argparse.Namespace(
            run_artifacts_path=str(tmp_path),
            input_path=str(input_path),
            delivery_planning_path=None,
        ),
    )
    observed = []
    stopped = RuntimeError("stop before external delivery work")

    async def plan(**kwargs):
        observed.extend(kwargs["case_results"])
        raise stopped

    def persist(**kwargs):
        observed.extend(kwargs["delivery_case_results"])
        raise stopped

    if replay is delivery_planning:
        monkeypatch.setattr(replay, "generate_delivery_plan", plan)
    else:
        monkeypatch.setattr(
            replay, "materialize_replay_input", lambda *args, **kwargs: None
        )
        monkeypatch.setattr(replay, "persist_delivery_execution_input", persist)

    if scenario == "invalid-blocked":
        with pytest.raises(ValidationError):
            await replay.main()
        assert observed == []
    elif scenario == "blocked":
        with pytest.raises(RuntimeError, match="does not contain deliverable cases"):
            await replay.main()
        assert observed == []
    else:
        with pytest.raises(RuntimeError) as raised:
            await replay.main()
        assert raised.value is stopped
        assert [case.case_id for case in observed] == ["approved"]
        assert observed[0].mitigation_overview == "Approved repair"
        assert observed[0].mitigator_file_changes == [
            {"path": "unsafe.py", "status": "deleted"}
        ]


@pytest.mark.parametrize("case_count", [0, 2])
def test_delivery_replay_result_matches_execution_contract(case_count: int) -> None:
    """Delivery replay must publish the same result shape as normal execution."""
    from sec_review_agents.delivery_stages.result import DeliveryResult
    from sec_review_agents.entrypoints.execution_api_schema import (
        validate_execution_api_result,
    )
    from sec_review_agents.review_stages.record import build_review_record
    from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult

    cases = [
        RepositoryCaseResult(
            case_id=f"case-{index}",
            deliverable=False,
            review_record=build_review_record(
                analysis_result=None,
                mitigation_result=None,
                verifier_result=None,
                cvss_result=None,
            ),
        ).model_dump(mode="json")
        for index in range(case_count)
    ]
    result = delivery_execution._repository_result_from_delivery_replay(
        previous_result={"deletion_review_skipped": True, "case_count": 99},
        delivery_result=DeliveryResult(status="skipped"),
        case_results=cases,
    )

    validate_execution_api_result(result, "repository-review")
    assert result["case_count"] == case_count
    assert result["case_results"] == cases
    assert result["deletion_review_skipped"] is True
