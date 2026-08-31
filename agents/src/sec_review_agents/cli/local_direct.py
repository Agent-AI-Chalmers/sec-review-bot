import asyncio
import sys
from typing import Any

from sec_review_agents.cli.local_execution import (
    build_local_workflow_request,
    direct_run_for_bundle,
)
from sec_review_agents.cli.local_materialization.common import ReviewBundle
from sec_review_agents.runner.temporal_config import DEFAULT_WORKFLOW_TIMEOUT_SECONDS


def run_local_direct_workflow(bundle: ReviewBundle) -> dict[str, Any]:
    print(
        "LOCAL_DIRECT_WARNING=direct runner calls Temporal activity functions "
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
    return dict(result)


__all__ = ["run_local_direct_workflow"]
