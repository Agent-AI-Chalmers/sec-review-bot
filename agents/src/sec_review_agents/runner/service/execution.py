from typing import Any, Protocol


class RunnerExecutionBackend(Protocol):
    async def start(
        self,
        *,
        workflow: str,
        run_id: str,
        input_data: dict[str, Any],
        runtime: Any = None,
    ) -> dict[str, Any]: ...

    async def get(self, run_id: str) -> dict[str, Any] | None: ...


__all__ = [
    "RunnerExecutionBackend",
]
