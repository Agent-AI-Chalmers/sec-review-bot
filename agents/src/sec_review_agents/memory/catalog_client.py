"""Strict HTTP client for coordinated memory state and revision commits."""

import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.contract_versions import MEMORY_CATALOG_API_VERSION
from sec_review_agents.utils.env import env_value

AGENT_MEMORY_CATALOG_URL_ENV = "AGENT_MEMORY_CATALOG_URL"
AGENT_MEMORY_CATALOG_TOKEN_ENV = "AGENT_MEMORY_CATALOG_TOKEN"
_API_ROOT = f"/{MEMORY_CATALOG_API_VERSION}"


class MemoryCatalogConflictError(RuntimeError):
    """A catalog identity or revision precondition conflicts with stored state."""


class MemoryMaintenancePausedError(MemoryCatalogConflictError):
    """The catalog refused a maintenance commit because automation is paused."""


def _error_code(detail: str) -> str | None:
    try:
        value = json.loads(detail)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    code = value.get("code")
    return code if isinstance(code, str) else None


@dataclass(frozen=True)
class MemoryCatalogClient:
    base_url: str
    token: str
    timeout_seconds: int = 30

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url.rstrip('/')}{path}",
            data=payload,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if payload else {}),
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                value = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            message = f"Memory catalog returned HTTP {error.code}: {detail}"
            if error.code == 409:
                if _error_code(detail) == "MAINTENANCE_PAUSED":
                    raise MemoryMaintenancePausedError(message) from error
                raise MemoryCatalogConflictError(message) from error
            raise RuntimeError(message) from error
        except URLError as error:
            raise RuntimeError(
                f"Memory catalog is unavailable: {error.reason}"
            ) from error
        if not isinstance(value, dict):
            raise RuntimeError("Memory catalog returned a non-object response.")
        return value

    def register_extraction(
        self,
        *,
        extraction_id: str,
        source_workflow: str,
        source_run_id: str,
        source_unit_id: str,
        diagnostic_bundle_digest: str,
        transcript_reference: ArtifactReference,
        observation_markdown: str | None,
    ) -> bool:
        value = self._request(
            "POST",
            f"{_API_ROOT}/extractions",
            {
                "extraction_id": extraction_id,
                "source_workflow": source_workflow,
                "source_run_id": source_run_id,
                "source_unit_id": source_unit_id,
                "diagnostic_bundle_digest": diagnostic_bundle_digest,
                "transcript_reference": transcript_reference.as_dict(),
                "observation": (
                    {"body_markdown": observation_markdown}
                    if observation_markdown is not None
                    else None
                ),
            },
        )
        if value.get("ok") is not True:
            raise RuntimeError("Memory catalog did not accept the extraction.")
        return value.get("created") is True

    def get_extraction(self, extraction_id: str) -> dict[str, Any]:
        return self._request(
            "GET", f"{_API_ROOT}/extractions/{quote(extraction_id, safe='')}"
        )

    def list_extractions(
        self,
        *,
        cursor: str | None = None,
        limit: int = 50,
        source_workflow: str | None = None,
        source_run_id: str | None = None,
        has_observation: bool | None = None,
    ) -> dict[str, Any]:
        parameters: dict[str, str | int] = {"limit": limit}
        if cursor is not None:
            parameters["cursor"] = cursor
        if source_workflow is not None:
            parameters["source_workflow"] = source_workflow
        if source_run_id is not None:
            parameters["source_run_id"] = source_run_id
        if has_observation is not None:
            parameters["has_observation"] = str(has_observation).lower()
        return self._request("GET", f"{_API_ROOT}/extractions?{urlencode(parameters)}")

    def list_observations(
        self,
        *,
        cursor: str | None = None,
        limit: int = 50,
        status: str | None = None,
        consumed_revision: int | None = None,
    ) -> dict[str, Any]:
        parameters: dict[str, str | int] = {"limit": limit}
        if cursor is not None:
            parameters["cursor"] = cursor
        if status is not None:
            parameters["status"] = status
        if consumed_revision is not None:
            parameters["consumed_revision"] = consumed_revision
        return self._request("GET", f"{_API_ROOT}/observations?{urlencode(parameters)}")

    def get_observation_backlog(self) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/observation-backlog")

    def get_maintenance_control(self) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/maintenance-control")

    def change_maintenance_control(
        self,
        *,
        target_state: str,
        operation_id: str,
        expected_generation: int,
        actor: dict[str, str],
    ) -> dict[str, Any]:
        if target_state not in {"enabled", "paused"}:
            raise ValueError("Maintenance control target state is invalid.")
        action = "resume" if target_state == "enabled" else "pause"
        return self._request(
            "POST",
            f"{_API_ROOT}/maintenance-control/{action}",
            {
                "operation_id": operation_id,
                "expected_generation": expected_generation,
                "actor": actor,
            },
        )

    def get_maintenance_input(self, *, limit: int) -> dict[str, Any] | None:
        value = self._request(
            "GET",
            f"{_API_ROOT}/maintenance-input?limit={limit}",
        )
        maintenance_input = value.get("input")
        if maintenance_input is None:
            return None
        if not isinstance(maintenance_input, dict):
            raise RuntimeError("Memory catalog returned invalid maintenance input.")
        return dict(maintenance_input)

    def create_memory_tree_revision(
        self,
        *,
        maintenance_id: str,
        expected_active_revision: int,
        extraction_ids: list[str],
        memory_tree_reference: ArtifactReference,
        maintenance_transcript_reference: ArtifactReference,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"{_API_ROOT}/memory-tree/revisions",
            {
                "expected_active_revision": expected_active_revision,
                "memory_tree_reference": memory_tree_reference.as_dict(),
                "source": {
                    "kind": "maintenance",
                    "maintenance_id": maintenance_id,
                    "extraction_ids": extraction_ids,
                    "transcript_reference": maintenance_transcript_reference.as_dict(),
                },
            },
        )

    def get_memory_tree(self) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/memory-tree")

    def get_memory_tree_revision(self, revision: int) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/memory-tree/revisions/{revision}")

    def list_memory_tree_revisions(
        self,
        *,
        before_revision: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        parameters = [f"limit={limit}"]
        if before_revision is not None:
            parameters.append(f"before_revision={before_revision}")
        return self._request(
            "GET", f"{_API_ROOT}/memory-tree/revisions?{'&'.join(parameters)}"
        )


def configured_memory_catalog_client() -> MemoryCatalogClient | None:
    url = env_value(AGENT_MEMORY_CATALOG_URL_ENV)
    if url is None:
        return None
    token = env_value(AGENT_MEMORY_CATALOG_TOKEN_ENV)
    if token is None:
        raise ValueError(
            f"{AGENT_MEMORY_CATALOG_TOKEN_ENV} is required when "
            f"{AGENT_MEMORY_CATALOG_URL_ENV} is configured."
        )
    return MemoryCatalogClient(base_url=url, token=token)


__all__ = [
    "AGENT_MEMORY_CATALOG_TOKEN_ENV",
    "AGENT_MEMORY_CATALOG_URL_ENV",
    "MemoryCatalogClient",
    "MemoryCatalogConflictError",
    "MemoryMaintenancePausedError",
    "configured_memory_catalog_client",
]
