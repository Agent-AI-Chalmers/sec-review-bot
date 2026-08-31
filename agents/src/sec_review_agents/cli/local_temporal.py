import asyncio
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio.client import Client
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.cli.local_execution import (
    build_local_workflow_request,
    local_workflow_id,
    temporal_run_for_bundle,
)
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    effective_issue_strategy,
)
from sec_review_agents.runner.temporal_config import (
    DEFAULT_TEMPORAL_ADDRESS,
    DEFAULT_TEMPORAL_NAMESPACE,
    DEFAULT_TEMPORAL_TASK_QUEUE,
    DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
)
from sec_review_agents.utils.env import env_value, parse_int_env


@dataclass(frozen=True)
class LocalTemporalConfig:
    address: str
    namespace: str
    task_queue: str
    workflow_timeout_seconds: int

    @classmethod
    def from_env(cls) -> LocalTemporalConfig:
        return cls(
            address=env_value("TEMPORAL_ADDRESS") or DEFAULT_TEMPORAL_ADDRESS,
            namespace=env_value("TEMPORAL_NAMESPACE") or DEFAULT_TEMPORAL_NAMESPACE,
            task_queue=env_value("TEMPORAL_TASK_QUEUE") or DEFAULT_TEMPORAL_TASK_QUEUE,
            workflow_timeout_seconds=parse_int_env(
                env_value("TEMPORAL_WORKFLOW_TIMEOUT_SECONDS"),
                DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
            )
            or DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
        )


def run_local_temporal_workflow(bundle: ReviewBundle) -> dict[str, Any]:
    return asyncio.run(_run_local_temporal_workflow(bundle))


async def _run_local_temporal_workflow(bundle: ReviewBundle) -> dict[str, Any]:
    config = LocalTemporalConfig.from_env()
    client = await Client.connect(config.address, namespace=config.namespace)
    request = build_local_workflow_request(
        bundle,
        timeout_seconds=config.workflow_timeout_seconds,
    )
    workflow_id = local_workflow_id(bundle)
    workflow_run = temporal_run_for_bundle(bundle)
    try:
        handle: Any = await client.start_workflow(
            workflow_run,
            request,
            id=workflow_id,
            task_queue=config.task_queue,
            execution_timeout=timedelta(seconds=config.workflow_timeout_seconds),
            memo={
                "workflow": bundle.workflow,
                "local": True,
                "issue_strategy": effective_issue_strategy(bundle),
            },
        )
    except WorkflowAlreadyStartedError:
        handle = client.get_workflow_handle(workflow_id)
    response = await handle.result()
    return _unwrap_runner_response(response)


def _unwrap_runner_response(response: Any) -> dict[str, Any]:
    if not isinstance(response, dict):
        raise RuntimeError("Local Temporal workflow returned a non-object response.")
    if response.get("ok") is True and isinstance(response.get("result"), dict):
        return response["result"]
    if response.get("ok") is False and isinstance(response.get("error"), dict):
        raise RuntimeError(
            "Local Temporal workflow failed: "
            + json.dumps(response["error"], ensure_ascii=False)
        )
    raise RuntimeError("Local Temporal workflow returned an invalid runner response.")


__all__ = [
    "LocalTemporalConfig",
    "run_local_temporal_workflow",
]
