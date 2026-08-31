from pathlib import Path

import pytest

from sec_review_agents.delivery_stages.planning.agent_passes import (
    run_delivery_planning,
)
from tests.integration.llm.probe_helpers import llm_probe

PROBE = llm_probe(
    run_env="RUN_LLM_DELIVERY_WORKBENCH_INTEGRATION",
    description="real LLM delivery workbench probe",
    requires_deployment=False,
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_llm_can_drive_delivery_planning_workbench_state_to_valid_export(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-delivery-workbench"
    workspace.mkdir(parents=True, exist_ok=True)
    run_artifacts.mkdir(parents=True, exist_ok=True)

    planning_cases = [
        {
            "case_id": "case-auth-header",
            "changed_files": ["src/auth.ts"],
        },
        {
            "case_id": "case-auth-token",
            "changed_files": ["src/auth.ts"],
        },
        {
            "case_id": "case-logging",
            "changed_files": ["src/logging.ts"],
        },
    ]

    result = await run_delivery_planning(
        delivery_planning_root=run_artifacts / "delivery-planning",
        planning_cases=planning_cases,
    )

    assert result["constraints"]["ok"] is True
    delivered_case_ids = sorted(
        case_id for delivery in result["deliveries"] for case_id in delivery["case_ids"]
    )
    assert delivered_case_ids == [
        "case-auth-header",
        "case-auth-token",
        "case-logging",
    ]
    assert (
        run_artifacts / "delivery-planning" / "delivery-planning-input.json"
    ).exists()
