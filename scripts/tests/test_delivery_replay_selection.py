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
        {"case_id": "blocked", "disposition": "blocked", "review_record": {}},
    ]
    if scenario != "blocked":
        cases.append(
            {
                "case_id": "approved",
                "disposition": "keep",
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
        observed.extend(kwargs["keep_case_results"])
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
        with pytest.raises(RuntimeError, match="does not contain keep case_results"):
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
