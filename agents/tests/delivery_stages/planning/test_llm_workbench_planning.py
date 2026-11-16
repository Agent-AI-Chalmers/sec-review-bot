from pathlib import Path

import pytest

from sec_review_agents.delivery_stages.model import DeliveryCaseInput
from sec_review_agents.delivery_stages.planning.stage import (
    generate_delivery_plan,
)
from tests.llm_probe import llm_probe

pytestmark = [pytest.mark.integration, pytest.mark.llm]

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
        DeliveryCaseInput.model_validate(
            {
                "disposition": "keep",
                "reason": None,
                "mitigation_overview": "",
                "mitigator_patch_diff": None,
                **item,
            }
        )
        for item in [
            {
                "case_id": "case-auth-header",
                "mitigator_file_changes": [
                    {
                        "path": "src/auth.ts",
                        "status": "upsert",
                        "content": "",
                        "content_encoding": "utf-8",
                    }
                ],
            },
            {
                "case_id": "case-auth-token",
                "mitigator_file_changes": [
                    {
                        "path": "src/auth.ts",
                        "status": "upsert",
                        "content": "",
                        "content_encoding": "utf-8",
                    }
                ],
            },
            {
                "case_id": "case-logging",
                "mitigator_file_changes": [
                    {
                        "path": "src/logging.ts",
                        "status": "upsert",
                        "content": "",
                        "content_encoding": "utf-8",
                    }
                ],
            },
        ]
    ]

    result = await generate_delivery_plan(
        run_artifacts_root=run_artifacts,
        case_results=planning_cases,
    )

    assert result.status == "completed"
    delivered_case_ids = sorted(
        case_id for delivery in result.deliveries for case_id in delivery.case_ids
    )
    assert delivered_case_ids == [
        "case-auth-header",
        "case-auth-token",
        "case-logging",
    ]
    assert (
        run_artifacts / "delivery-planning" / "delivery-planning-input.json"
    ).exists()
