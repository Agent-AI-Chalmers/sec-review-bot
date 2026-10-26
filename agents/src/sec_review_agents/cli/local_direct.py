import asyncio
import sys
from pathlib import Path
from typing import Any

from sec_review_agents.cli.local_execution import (
    build_local_workflow_request,
    direct_run_for_bundle,
)
from sec_review_agents.cli.local_materialization.common import ReviewBundle
from sec_review_agents.run_diagnostics.bundle import (
    DiagnosticReviewUnit,
    publish_run_diagnostic_bundle,
)
from sec_review_agents.temporal.config import DEFAULT_WORKFLOW_TIMEOUT_SECONDS


def run_local_direct_workflow(bundle: ReviewBundle) -> dict[str, Any]:
    print(
        "LOCAL_DIRECT_WARNING=local direct execution calls Temporal activity functions "
        "directly as local Python functions; it does not provide Temporal retries, "
        "scheduling, or failure handling. Use --temporal to exercise the Temporal "
        "workflow path.",
        file=sys.stderr,
    )
    request = build_local_workflow_request(
        bundle,
        timeout_seconds=DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
    )
    run_direct = direct_run_for_bundle(bundle)
    result = asyncio.run(run_direct(request))
    _publish_local_diagnostic(bundle, result=dict(result))
    return dict(result)


def _publish_local_diagnostic(
    bundle: ReviewBundle,
    *,
    result: dict[str, Any],
) -> None:
    artifact_root = bundle.artifact_root_path
    if bundle.workflow == "repository-review":
        units = [
            DiagnosticReviewUnit(
                unit_id=case_root.name,
                transcript_root=case_root / "transcripts",
            )
            for case_root in sorted((artifact_root / "cases").glob("*"))
            if case_root.is_dir() and list((case_root / "transcripts").glob("*.jsonl"))
        ]
    else:
        transcript_root = artifact_root / "transcripts"
        units = (
            [DiagnosticReviewUnit("review", transcript_root)]
            if list(transcript_root.glob("*.jsonl"))
            else []
        )
    # Direct mode is an offline producer even when the shell also carries
    # managed-deployment S3 settings.
    publish_run_diagnostic_bundle(
        run_id=bundle.run_id,
        artifact_root=Path(artifact_root),
        review_units=units,
        result=result,
        remote=False,
    )


__all__ = ["run_local_direct_workflow"]
