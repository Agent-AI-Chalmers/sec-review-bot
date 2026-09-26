import argparse
import asyncio
import json
import os
from pathlib import Path

from sec_review_agents.cli.local_execution import (
    build_local_workflow_request,
    direct_run_for_bundle,
)
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    default_local_output_dir,
    result_path_for_bundle,
)
from sec_review_agents.runner.temporal_config import DEFAULT_WORKFLOW_TIMEOUT_SECONDS
from sec_review_agents.runtime.runtime_config import (
    ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV,
)
from sec_review_agents.utils.env import bootstrap_agents_env

from scripts.patcheval.issue_bundle import build_patcheval_issue_bundle


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize and run a PatchEval-backed issue-review workflow."
    )
    parser.add_argument(
        "--cve", required=True, help="Target CVE id from PatchEval, e.g. CVE-2022-0767."
    )
    parser.add_argument(
        "--dataset",
        default="PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json",
        help="Path to the enriched PatchEval runtime subset dataset JSON file.",
    )
    parser.add_argument(
        "--output-dir",
        help="Directory where the materialized PatchEval workspace should be created. Defaults to a temp root.",
    )
    parser.add_argument(
        "--location-oracle",
        action="store_true",
        help="Use PatchEval location-oracle mode. Default is end-to-end mode.",
    )
    parser.add_argument(
        "--two-stage",
        action="store_true",
        help="Run the PatchEval case through the local issue-review-two-stage ablation path.",
    )
    parser.add_argument(
        "--single-agent",
        action="store_true",
        help="Run the PatchEval case through the local issue-review-single-agent baseline.",
    )
    return parser.parse_args()


async def _run_patcheval_issue_bundle(bundle: ReviewBundle) -> dict:
    request = build_local_workflow_request(
        bundle,
        timeout_seconds=DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
    )
    return dict(await direct_run_for_bundle(bundle)(request))


async def main() -> None:
    bootstrap_agents_env()
    # PatchEval cases intentionally replay benchmark-provided sandbox images.
    os.environ.setdefault(ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV, "true")
    args = parse_args()
    if args.two_stage and args.single_agent:
        raise SystemExit("--two-stage and --single-agent are mutually exclusive.")
    dataset_path = Path(args.dataset).resolve()
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else default_local_output_dir()
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    bundle = build_patcheval_issue_bundle(
        cve_id=args.cve,
        dataset_path=dataset_path,
        output_dir=output_dir,
        location_oracle=args.location_oracle,
        two_stage=args.two_stage,
        single_agent=args.single_agent,
    )

    print(f"LOCAL_ROOT={bundle.input['input_bundle_uri']}")

    result = await _run_patcheval_issue_bundle(bundle)

    result_path = result_path_for_bundle(bundle)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"WORKFLOW_RESULT={result_path}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
