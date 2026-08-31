from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio.client import (
    Client,
    WorkflowExecutionStatus,
)
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from sec_review_agents.runner.core import build_runner_error
from sec_review_agents.runner.service.workflow import (
    RunnerExecutionRequest,
    RunnerExecutionWorkflow,
)
from sec_review_agents.runner.temporal_config import (
    DEFAULT_TEMPORAL_ADDRESS,
    DEFAULT_TEMPORAL_NAMESPACE,
    DEFAULT_TEMPORAL_TASK_QUEUE,
    DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
)
from sec_review_agents.utils.env import env_value, parse_int_env


@dataclass
class TemporalRunnerExecutionBackend:
    address: str = DEFAULT_TEMPORAL_ADDRESS
    namespace: str = DEFAULT_TEMPORAL_NAMESPACE
    task_queue: str = DEFAULT_TEMPORAL_TASK_QUEUE
    workflow_timeout_seconds: int = DEFAULT_WORKFLOW_TIMEOUT_SECONDS
    _client: Client | None = field(default=None, init=False, repr=False)

    @classmethod
    def from_env(cls) -> TemporalRunnerExecutionBackend:
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

    async def start(
        self,
        *,
        workflow: str,
        run_id: str,
        input_data: dict[str, Any],
        runtime: Any = None,
    ) -> dict[str, Any]:
        client = await self._get_client()
        request = RunnerExecutionRequest(
            workflow=workflow,
            run_id=run_id,
            input_data=input_data,
            timeout_seconds=self.workflow_timeout_seconds,
            runtime=runtime,
        )
        try:
            handle = await client.start_workflow(
                RunnerExecutionWorkflow.run,
                request,
                id=run_id,
                task_queue=self.task_queue,
                execution_timeout=timedelta(seconds=self.workflow_timeout_seconds),
                memo={"workflow": workflow},
            )
        except WorkflowAlreadyStartedError:
            handle = client.get_workflow_handle(run_id)
        return await _record_from_handle(handle, default_workflow=workflow)

    async def get(self, run_id: str) -> dict[str, Any] | None:
        client = await self._get_client()
        handle = client.get_workflow_handle(run_id)
        try:
            return await _record_from_handle(handle)
        except RPCError as error:
            if error.status is RPCStatusCode.NOT_FOUND:
                return None
            raise

    async def _get_client(self) -> Client:
        if self._client is None:
            self._client = await Client.connect(
                self.address,
                namespace=self.namespace,
            )
        return self._client


async def _record_from_handle(
    handle: Any,
    *,
    default_workflow: str | None = None,
) -> dict[str, Any]:
    description = await handle.describe()
    temporal_status = description.status
    temporal_status_name = (
        temporal_status.name if temporal_status is not None else "UNKNOWN"
    )
    status = _status_from_temporal(temporal_status)
    workflow = _workflow_from_memo(await description.memo()) or default_workflow
    record: dict[str, Any] = {
        "run_id": handle.id,
        "workflow": workflow,
        "status": status,
    }
    if description.status is WorkflowExecutionStatus.COMPLETED:
        response = await handle.result()
        if isinstance(response, dict):
            if response.get("ok") is True and "result" in response:
                record["status"] = "succeeded"
                record["result"] = response["result"]
                return record
            if response.get("ok") is False and "error" in response:
                record["status"] = "failed"
                record["error"] = response["error"]
                return record
        record["status"] = "failed"
        record["error"] = build_runner_error(
            code="RUNNER_RESPONSE_INVALID",
            category="runtime",
            message="Temporal workflow completed with an invalid runner response envelope.",
            details={
                "temporal_status": temporal_status_name,
                "response_type": type(response).__name__,
                **({"ok": response.get("ok")} if isinstance(response, dict) else {}),
            },
        )
    elif status == "failed":
        record["error"] = await _failed_workflow_error(
            handle,
            temporal_status=temporal_status_name,
        )
    return record


def _status_from_temporal(status: WorkflowExecutionStatus | None) -> str:
    if status is WorkflowExecutionStatus.RUNNING:
        return "running"
    if status is WorkflowExecutionStatus.COMPLETED:
        return "succeeded"
    return "failed"


def _workflow_from_memo(memo: Mapping[str, Any] | None) -> str | None:
    if not isinstance(memo, Mapping):
        return None
    value = memo.get("workflow")
    return value if isinstance(value, str) and value else None


async def _failed_workflow_error(
    handle: Any,
    *,
    temporal_status: str,
) -> dict[str, Any]:
    try:
        await handle.result()
    except Exception as error:
        root_cause = _root_cause(error)
        return build_runner_error(
            code="RUNNER_EXECUTION_FAILED",
            category="runtime",
            message=_failure_message(root_cause),
            details={
                "temporal_status": temporal_status,
                "name": _failure_name(root_cause),
                "failure_chain": _failure_chain(error),
            },
        )
    return build_runner_error(
        code="RUNNER_EXECUTION_FAILED",
        category="runtime",
        message=f"Temporal workflow ended with status {temporal_status}.",
        details={"temporal_status": temporal_status},
    )


def _root_cause(error: Exception) -> BaseException:
    current: BaseException = error
    seen: set[int] = set()
    while current.__cause__ is not None and id(current.__cause__) not in seen:
        seen.add(id(current))
        current = current.__cause__
    return current


def _failure_chain(error: Exception) -> list[dict[str, str]]:
    chain: list[dict[str, str]] = []
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(
            {
                "name": _failure_name(current),
                "message": _failure_message(current),
            }
        )
        current = current.__cause__
    return chain


def _failure_name(error: BaseException) -> str:
    failure_type = getattr(error, "type", None)
    if isinstance(failure_type, str) and failure_type:
        return failure_type
    return type(error).__name__


def _failure_message(error: BaseException) -> str:
    message = str(error).strip()
    return message or type(error).__name__


__all__ = [
    "TemporalRunnerExecutionBackend",
]
