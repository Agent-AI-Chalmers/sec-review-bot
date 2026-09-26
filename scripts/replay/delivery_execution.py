# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from sec_review_agents.delivery_stages.execution import (
    build_delivery_execution_input,
    execute_delivery_entry,
    persist_delivery_execution_input,
)
from sec_review_agents.delivery_stages.result import (
    build_delivery_result_from_outcomes,
    persist_delivery_result,
)
from sec_review_agents.utils.env import bootstrap_agents_env, env_value
from sec_review_agents.utils.files import persist_json
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.repository.result import (
    build_scan_summary,
)
from sec_review_agents.workflows.repository.workflow import (
    project_repository_case_result_for_delivery,
)

from scripts.replay.input_bundle import read_json

ENV_RUN_ARTIFACTS_PATH = "REPOSITORY_DELIVERY_EXECUTION_RUN_ARTIFACTS_PATH"
ENV_INPUT_PATH = "REPOSITORY_DELIVERY_EXECUTION_INPUT_PATH"
ENV_DELIVERY_PLAN_PATH = "REPOSITORY_DELIVERY_EXECUTION_PLAN_PATH"


def _resolve_input_path(run_artifacts: Path, input_path: str | None) -> Path:
    if input_path:
        return Path(input_path).resolve()
    return run_artifacts.parent.parent / "repository-review-input.json"


def _load_result(run_artifacts: Path) -> dict[str, Any]:
    path = run_artifacts / "repository-review-result.json"
    if path.exists():
        return read_json(path)
    raise FileNotFoundError(f"Cannot find repository result: {path}")


def _previous_scan_summary(result: dict[str, Any]) -> dict[str, Any]:
    value = result.get("scan_summary")
    if isinstance(value, dict):
        return value
    return build_scan_summary(discovery_result=None, triage_result=None)


def _repository_result_from_delivery_replay(
    *,
    previous_result: dict[str, Any],
    delivery_result: dict[str, Any],
    case_results: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "contract_version": "v4",
        "scan_summary": _previous_scan_summary(previous_result),
        "deliveries": [
            item
            for item in (delivery_result.get("deliveries") or [])
            if isinstance(item, dict)
        ],
        "case_results": case_results,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run repository-review delivery execution only using existing "
            "case_results and an existing delivery-plan.json."
        )
    )
    parser.add_argument(
        "--run-artifacts-path",
        default=env_value(ENV_RUN_ARTIFACTS_PATH),
        help=(f"Path to artifacts/run-... directory. Env: {ENV_RUN_ARTIFACTS_PATH}."),
    )
    parser.add_argument(
        "--input-path",
        default=env_value(ENV_INPUT_PATH),
        help=(
            "Optional repository-review-input.json path. Defaults to "
            f"<workspace-root>/repository-review-input.json. Env: {ENV_INPUT_PATH}."
        ),
    )
    parser.add_argument(
        "--delivery-planning-path",
        default=env_value(ENV_DELIVERY_PLAN_PATH),
        help=(
            "Optional delivery-plan.json path. Defaults to "
            f"<run-artifacts-path>/delivery-planning/delivery-plan.json. Env: {ENV_DELIVERY_PLAN_PATH}."
        ),
    )
    return parser.parse_args()


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    if not args.run_artifacts_path:
        raise ValueError(
            "Missing run artifacts path. Set "
            f"{ENV_RUN_ARTIFACTS_PATH}=<artifacts/run-id> "
            "or pass --run-artifacts-path."
        )

    run_artifacts = Path(args.run_artifacts_path).resolve()
    if not run_artifacts.exists():
        raise FileNotFoundError(f"Run artifacts path does not exist: {run_artifacts}")

    input_path = _resolve_input_path(run_artifacts, args.input_path)
    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")

    plan_path = (
        Path(args.delivery_planning_path).resolve()
        if args.delivery_planning_path
        else run_artifacts / "delivery-planning" / "delivery-plan.json"
    )

    replay_input = read_json(input_path)
    previous_result = _load_result(run_artifacts)

    # Delivery replay bypasses runner input preparation and reuses existing
    # stage artifacts, so it must restore prepared-input runtime roots here.
    replay_input["artifact_paths"] = {
        "discovery": str(run_artifacts / "discovery"),
        "triage": str(run_artifacts / "triage"),
        "cases": str(run_artifacts / "cases"),
    }

    if not plan_path.exists():
        raise FileNotFoundError(f"Delivery plan does not exist: {plan_path}")
    delivery_plan = read_json(plan_path)

    if not delivery_plan.get("deliveries"):
        raise RuntimeError("Delivery plan does not contain deliveries.")

    case_results = previous_result.get("case_results") or []
    if not isinstance(case_results, list) or not case_results:
        raise RuntimeError("Repository result does not contain case_results.")

    keep_case_results = [
        item for item in case_results if item.get("disposition") == "keep"
    ]
    if not keep_case_results:
        raise RuntimeError(
            "Repository result does not contain keep case_results for delivery execution."
        )

    local_root = required_path(
        replay_input.get("input_bundle_uri"),
        label="input_bundle_uri",
    )
    delivery_case_inputs = [
        project_repository_case_result_for_delivery(item) for item in keep_case_results
    ]
    persist_delivery_execution_input(
        run_artifacts_root=run_artifacts,
        deliveries=delivery_plan["deliveries"],
        keep_case_results=delivery_case_inputs,
    )
    workspace_snapshot_tar_path = required_path(
        (replay_input.get("bundle_paths") or {}).get("workspace_snapshot_tar_path")
        or (Path(local_root) / "workspace.snapshot.tar"),
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    delivery_execution = build_delivery_execution_input(
        run_artifacts_root=run_artifacts,
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        deliveries=delivery_plan["deliveries"],
        keep_case_results=delivery_case_inputs,
    )
    patch_outcomes = []
    for delivery_request in (
        delivery_execution["single_delivery_execution_items"]
        + delivery_execution["combined_delivery_execution_items"]
    ):
        outcome = await execute_delivery_entry(
            run_artifacts_root=run_artifacts,
            baseline_snapshot_tar_path=workspace_snapshot_tar_path,
            delivery_entry=delivery_request["delivery"],
            case_results=delivery_request["case_items"],
        )
        if outcome is not None:
            patch_outcomes.append(outcome)

    delivery_result = build_delivery_result_from_outcomes(
        deliveries=delivery_execution["deliveries"],
        keep_case_ids=delivery_execution["keep_case_ids"],
        patch_outcomes=patch_outcomes,
    )
    persist_delivery_result(run_artifacts_root=run_artifacts, result=delivery_result)

    workflow_result = _repository_result_from_delivery_replay(
        previous_result=previous_result,
        delivery_result=delivery_result,
        case_results=case_results,
    )

    persist_json(run_artifacts, "repository-review-result.json", workflow_result)
    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_artifacts.name,
                "delivery_plan_status": delivery_plan.get("status"),
                "delivery_plan_delivery_count": len(
                    delivery_plan.get("deliveries") or []
                ),
                "delivery_status": delivery_result.get("status"),
                "delivery_count": len(delivery_result.get("deliveries") or []),
                "case_result_count": len(case_results),
                "result_path": str(run_artifacts / "repository-review-result.json"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
