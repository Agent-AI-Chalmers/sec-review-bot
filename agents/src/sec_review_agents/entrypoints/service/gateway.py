"""Define how the HTTP service starts runs and reads their current state."""

from typing import Any, Protocol


class RunnerRunConflictError(Exception):
    """The requested run ID is already bound to a different runner request."""

    def __init__(
        self,
        run_id: str,
        *,
        requested_workflow: str,
        existing_workflow: str | None,
    ) -> None:
        super().__init__(f"Runner run_id {run_id} is already bound to another request.")
        self.run_id = run_id
        self.requested_workflow = requested_workflow
        self.existing_workflow = existing_workflow


class RunnerWorkflowGateway(Protocol):
    """Starts workflows and reads their current results for the Runner HTTP service."""

    async def start(
        self,
        *,
        workflow: str,
        run_id: str,
        input_data: dict[str, Any],
        runtime: Any = None,
    ) -> dict[str, Any]:
        """Submit a workflow request and return its current run record."""
        ...

    async def get(self, run_id: str) -> dict[str, Any] | None:
        """Return the current run record, or None when the run does not exist."""
        ...


__all__ = [
    "RunnerRunConflictError",
    "RunnerWorkflowGateway",
]
