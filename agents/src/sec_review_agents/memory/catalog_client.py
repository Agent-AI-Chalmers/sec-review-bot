"""Strict HTTP client for coordinated memory state and version commits."""

import json
from dataclasses import dataclass
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from sec_review_agents.agents.memory_maintainer.model import MemoryMaintenanceOutput
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.contract_versions import MEMORY_CATALOG_API_VERSION
from sec_review_agents.memory.catalog_schema import validate_catalog_response
from sec_review_agents.utils.env import env_value

AGENT_MEMORY_CATALOG_URL_ENV = "AGENT_MEMORY_CATALOG_URL"
AGENT_MEMORY_CATALOG_TOKEN_ENV = "AGENT_MEMORY_CATALOG_TOKEN"
_API_ROOT = f"/{MEMORY_CATALOG_API_VERSION}"


class _RejectRedirects(HTTPRedirectHandler):
    """Keep the catalog bearer token on the configured origin only."""

    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


_CATALOG_OPENER = build_opener(_RejectRedirects())


def _open_catalog_request(request: Request, *, timeout: int) -> Any:
    return _CATALOG_OPENER.open(request, timeout=timeout)


class MemoryCatalogConflictError(RuntimeError):
    """A catalog identity or version precondition conflicts with stored state."""


class MemoryPublicationAbandonedError(MemoryCatalogConflictError):
    """The version candidate was abandoned and cannot be committed."""


class MemoryAutomationPausedError(MemoryCatalogConflictError):
    """The catalog refused a new automatic memory-tree version while automation is paused."""


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
            with _open_catalog_request(
                request, timeout=self.timeout_seconds
            ) as response:
                value = json.loads(response.read().decode("utf-8"))
                validate_catalog_response(method, path, response.status, value)
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            try:
                error_body = json.loads(detail)
                validate_catalog_response(method, path, error.code, error_body)
            except (ValueError, RuntimeError) as invalid:
                raise RuntimeError(
                    f"Memory catalog returned invalid HTTP {error.code} response."
                ) from invalid
            message = f"Memory catalog returned HTTP {error.code}: {detail}"
            if error.code == 409:
                if _error_code(detail) == "AUTOMATION_PAUSED":
                    raise MemoryAutomationPausedError(message) from error
                if _error_code(detail) == "PUBLICATION_ABANDONED":
                    raise MemoryPublicationAbandonedError(message) from error
                raise MemoryCatalogConflictError(message) from error
            raise RuntimeError(message) from error
        except URLError as error:
            raise RuntimeError(
                f"Memory catalog is unavailable: {error.reason}"
            ) from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RuntimeError("Memory catalog returned invalid JSON.") from error
        if not isinstance(value, dict):
            raise RuntimeError("Memory catalog returned a non-object response.")
        return value

    def list_extraction_publications(self, extraction_id: str) -> list[dict[str, Any]]:
        value = self._request(
            "GET",
            f"{_API_ROOT}/extractions/publications/{quote(extraction_id, safe='')}",
        )
        return value["publications"]

    def reserve_extraction_publication(self, intent: dict[str, Any]) -> None:
        self._request("POST", f"{_API_ROOT}/extractions/publications/reserve", intent)

    def confirm_extraction_publication(self, intent: dict[str, Any]) -> None:
        self._request("POST", f"{_API_ROOT}/extractions/publications/confirm", intent)

    def list_version_publications(
        self,
        operation_id: str,
        *,
        kind: Literal["learning", "reorganization"] = "learning",
    ) -> list[dict[str, Any]]:
        value = self._request(
            "GET",
            f"{_API_ROOT}/memory-tree/versions/publications/{kind}/{quote(operation_id, safe='')}",
        )
        return value["publications"]

    def abandon_version_publications(
        self, operation_id: str, *, kind: Literal["learning", "reorganization"]
    ) -> None:
        self._request(
            "POST",
            f"{_API_ROOT}/memory-tree/versions/publications/abandon",
            {"kind": kind, "operation_id": operation_id},
        )

    def reserve_version_publication(self, intent: dict[str, Any]) -> None:
        result = self._request(
            "POST", f"{_API_ROOT}/memory-tree/versions/publications/reserve", intent
        )
        if result["status"] == "abandoned":
            raise MemoryPublicationAbandonedError(
                "Version publication has been abandoned."
            )

    def confirm_version_publication(self, intent: dict[str, Any]) -> None:
        result = self._request(
            "POST", f"{_API_ROOT}/memory-tree/versions/publications/confirm", intent
        )
        if result["status"] == "abandoned":
            raise MemoryPublicationAbandonedError(
                "Version publication has been abandoned."
            )

    def register_extraction(
        self,
        *,
        extraction_id: str,
        source_workflow: str,
        source_run_id: str,
        source_unit_id: str,
        execution_archive_digest: str,
        trajectory_reference: ArtifactReference,
        observations: list[dict[str, str]],
    ) -> bool:
        value = self._request(
            "POST",
            f"{_API_ROOT}/extractions",
            {
                "extraction_id": extraction_id,
                "source_workflow": source_workflow,
                "source_run_id": source_run_id,
                "source_unit_id": source_unit_id,
                "execution_archive_digest": execution_archive_digest,
                "trajectory_reference": trajectory_reference.as_dict(),
                "observations": observations,
            },
        )
        return value["created"]

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
        consumed_version: int | None = None,
    ) -> dict[str, Any]:
        parameters: dict[str, str | int] = {"limit": limit}
        if cursor is not None:
            parameters["cursor"] = cursor
        if status is not None:
            parameters["status"] = status
        if consumed_version is not None:
            parameters["consumed_version"] = consumed_version
        return self._request("GET", f"{_API_ROOT}/observations?{urlencode(parameters)}")

    def get_observation_backlog(self) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/observation-backlog")

    def get_memory_tree_automation(self) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/memory-tree/automation")

    def change_memory_tree_automation(
        self,
        *,
        target_state: str,
        operation_id: str,
        expected_version: int,
    ) -> dict[str, Any]:
        if target_state not in {"enabled", "paused"}:
            raise ValueError("Memory-tree automation target state is invalid.")
        action = "resume" if target_state == "enabled" else "pause"
        return self._request(
            "POST",
            f"{_API_ROOT}/memory-tree/automation/{action}",
            {
                "operation_id": operation_id,
                "expected_version": expected_version,
            },
        )

    def get_learning_input(self, *, limit: int) -> dict[str, Any] | None:
        value = self._request(
            "GET",
            f"{_API_ROOT}/learning-input?limit={limit}",
        )
        return value["input"]

    def create_learning_version(
        self,
        *,
        operation_id: str,
        expected_active_version: int,
        observation_ids: list[str],
        memory_tree_reference: ArtifactReference,
        trajectory_reference: ArtifactReference,
        maintenance_report: MemoryMaintenanceOutput,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"{_API_ROOT}/memory-tree/versions",
            {
                "expected_active_version": expected_active_version,
                "memory_tree_reference": memory_tree_reference.as_dict(),
                "source": {
                    "kind": "learning",
                    "operation_id": operation_id,
                    "observation_ids": observation_ids,
                    "trajectory_reference": trajectory_reference.as_dict(),
                    "maintenance_report": maintenance_report.model_dump(mode="json"),
                },
            },
        )

    def create_reorganization_version(
        self,
        *,
        operation_id: str,
        expected_active_version: int,
        memory_tree_reference: ArtifactReference,
        trajectory_reference: ArtifactReference,
        maintenance_report: MemoryMaintenanceOutput,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"{_API_ROOT}/memory-tree/versions",
            {
                "expected_active_version": expected_active_version,
                "memory_tree_reference": memory_tree_reference.as_dict(),
                "source": {
                    "kind": "reorganization",
                    "operation_id": operation_id,
                    "trajectory_reference": trajectory_reference.as_dict(),
                    "maintenance_report": maintenance_report.model_dump(mode="json"),
                },
            },
        )

    def get_memory_tree(self) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/memory-tree")

    def get_memory_tree_version(self, version: int) -> dict[str, Any]:
        return self._request("GET", f"{_API_ROOT}/memory-tree/versions/{version}")

    def list_memory_tree_versions(
        self,
        *,
        before_version: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        parameters = [f"limit={limit}"]
        if before_version is not None:
            parameters.append(f"before_version={before_version}")
        return self._request(
            "GET", f"{_API_ROOT}/memory-tree/versions?{'&'.join(parameters)}"
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
    "MemoryAutomationPausedError",
    "MemoryCatalogClient",
    "MemoryCatalogConflictError",
    "MemoryPublicationAbandonedError",
    "configured_memory_catalog_client",
]
