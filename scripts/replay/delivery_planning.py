# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from sec_review_agents.delivery_stages.planning import generate_delivery_plan
from sec_review_agents.utils.env import bootstrap_agents_env, env_value
from sec_review_agents.workflows.repository.workflow import (
    project_repository_case_result_for_delivery,
)

from scripts.replay.input_bundle import read_json

ENV_RUN_ARTIFACTS_PATH = "REPOSITORY_DELIVERY_PLANNING_RUN_ARTIFACTS_PATH"
ENV_INPUT_PATH = "REPOSITORY_DELIVERY_PLANNING_INPUT_PATH"


def _resolve_input_path(run_artifacts: Path, input_path: str | None) -> Path:
    if input_path:
        return Path(input_path).resolve()
    return run_artifacts.parent.parent / "repository-review-input.json"


def _load_result(run_artifacts: Path) -> dict[str, Any]:
    path = run_artifacts / "repository-review-result.json"
    if path.exists():
        return read_json(path)
    raise FileNotFoundError(f"Cannot find repository result: {path}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run repository-review delivery planning only using existing "
            "case_results from a repository result."
        )
    )
    parser.add_argument(
        "--run-artifacts-path",
        default=env_value(ENV_RUN_ARTIFACTS_PATH),
        help=(
            "Path to artifacts/run-... directory. Env: " f"{ENV_RUN_ARTIFACTS_PATH}."
        ),
    )
    parser.add_argument(
        "--input-path",
        default=env_value(ENV_INPUT_PATH),
        help=(
            "Optional repository-review-input.json path. Defaults to "
            f"<workspace-root>/repository-review-input.json. Env: {ENV_INPUT_PATH}."
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

    replay_input = read_json(input_path)
    previous_result = _load_result(run_artifacts)

    # Delivery planning replay starts after runner input preparation. Hydrate
    # only prepared-input runtime roots, not caller materialization.
    replay_input["artifact_paths"] = {
        "discovery": str(run_artifacts / "discovery"),
        "triage": str(run_artifacts / "triage"),
        "cases": str(run_artifacts / "cases"),
    }

    case_results = previous_result.get("case_results") or []
    keep_case_results = [
        item
        for item in case_results
        if isinstance(item, dict) and item.get("disposition") == "keep"
    ]
    if not keep_case_results:
        raise RuntimeError(
            "Repository result does not contain keep case_results for delivery planning."
        )

    delivery_plan = await generate_delivery_plan(
        run_artifacts_root=run_artifacts,
        case_results=[
            project_repository_case_result_for_delivery(item)
            for item in keep_case_results
        ],
    )
    result_path = run_artifacts / "delivery-planning" / "delivery-plan.json"

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_artifacts.name,
                "keep_case_count": len(keep_case_results),
                "delivery_plan_status": delivery_plan.get("status"),
                "delivery_plan_delivery_count": len(
                    delivery_plan.get("deliveries") or []
                ),
                "result_path": str(result_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
