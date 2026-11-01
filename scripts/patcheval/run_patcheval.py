import argparse
import asyncio
import json
import os
import time
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
from sec_review_agents.runtime.runtime_config import (
    ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV,
)
from sec_review_agents.temporal.config import DEFAULT_WORKFLOW_TIMEOUT_SECONDS
from sec_review_agents.utils.env import bootstrap_agents_env

from scripts.patcheval.batch import activate
from scripts.patcheval.experiments import (
    EXECUTED_EXPERIMENTS,
    EXECUTED_EXPERIMENTS_BY_NAME,
)
from scripts.patcheval.issue_bundle import build_patcheval_issue_bundle
from scripts.patcheval.patch_execution import run_default, write_state


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
        "--variant",
        choices=EXECUTED_EXPERIMENTS,
        default=EXECUTED_EXPERIMENTS[0],
        help="Experiment from the PatchEval matrix. Defaults to %(default)s.",
    )
    parser.add_argument(
        "--batch-dir",
        type=Path,
        help="Private frozen batch directory created by the pool",
    )
    parser.add_argument(
        "--skip-final-verifier",
        action="store_true",
        help="Default workflow: omit verification only after retry allowance is exhausted",
    )
    parser.add_argument(
        "--container-label", help="Attempt-specific Docker cleanup label"
    )
    args = parser.parse_args()
    if (
        args.skip_final_verifier
        and EXECUTED_EXPERIMENTS_BY_NAME[args.variant].issue_strategy != "default"
    ):
        parser.error("--skip-final-verifier requires a default workflow")
    return args


async def _run_patcheval_issue_bundle(
    bundle: ReviewBundle, *, skip_final: bool = False
) -> dict:
    request = build_local_workflow_request(
        bundle, timeout_seconds=DEFAULT_WORKFLOW_TIMEOUT_SECONDS
    )
    run = bundle.local_root_path
    started = time.monotonic()
    state = {"phase": "running", "final_verifier_omitted": False}
    write_state(run, state)
    try:
        # Preserve the production direct runner unless the benchmark explicitly
        # requests a different terminal-verification policy.
        if skip_final and bundle.issue_strategy == "default":
            result = await run_default(
                request, run, skip_final=skip_final, state=state, started=started
            )
        else:
            result = dict(await direct_run_for_bundle(bundle)(request))
        state["execution_status"] = "completed"
        return result
    except BaseException:
        state["execution_status"] = "failed"
        raise
    finally:
        state["workflow_seconds"] = time.monotonic() - started
        write_state(run, state)


async def main() -> None:
    bootstrap_agents_env()
    # PatchEval cases intentionally replay benchmark-provided sandbox images.
    os.environ.setdefault(ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV, "true")
    args = parse_args()
    spec = EXECUTED_EXPERIMENTS_BY_NAME[args.variant]
    dataset_path = (
        activate(
            args.batch_dir.resolve(),
            Path(__file__).resolve().parents[2],
            skip_final=args.skip_final_verifier,
            variant=args.variant,
        )
        if args.batch_dir
        else Path(args.dataset).resolve()
    )
    # Apply after frozen-environment activation too: neither direct execution nor
    # an older snapshot may enable outbound access for benchmark sandboxes.
    os.environ["AGENT_DOCKER_NETWORK_MODE"] = "none"
    os.environ[ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV] = "true"
    if args.container_label:
        os.environ["AGENT_DOCKER_RUN_LABEL"] = args.container_label
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
        location_oracle=spec.location_oracle,
        two_stage=spec.issue_strategy == "two-stage",
        single_agent=spec.issue_strategy == "single-agent",
    )

    print(f"LOCAL_ROOT={bundle.local_root_path}", flush=True)
    (bundle.local_root_path / "experiment-name.txt").write_text(
        f"{args.cve}-{args.variant}\n"
    )
    (bundle.local_root_path / "experiment-config.json").write_text(
        json.dumps(
            {
                "variant": args.variant,
                "batch_dir": str(args.batch_dir) if args.batch_dir else None,
                "skip_final_verifier": args.skip_final_verifier,
            },
            indent=2,
        )
    )

    result = await _run_patcheval_issue_bundle(
        bundle, skip_final=args.skip_final_verifier
    )

    result_path = result_path_for_bundle(bundle)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"WORKFLOW_RESULT={result_path}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
