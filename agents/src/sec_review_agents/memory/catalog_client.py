"""Strict HTTP client for the managed memory catalog."""

import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.utils.env import env_value

AGENT_MEMORY_CATALOG_URL_ENV = "AGENT_MEMORY_CATALOG_URL"
AGENT_MEMORY_CATALOG_TOKEN_ENV = "AGENT_MEMORY_CATALOG_TOKEN"


class MemoryCatalogConflictError(RuntimeError):
    """The requested immutable catalog identity already has different content."""


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
                raise MemoryCatalogConflictError(message) from error
            raise RuntimeError(message) from error
        except URLError as error:
            raise RuntimeError(
                f"Memory catalog is unavailable: {error.reason}"
            ) from error
        if not isinstance(value, dict):
            raise RuntimeError("Memory catalog returned a non-object response.")
        return value

    def register_observation(
        self,
        *,
        observation_id: str,
        source_workflow: str,
        source_run_id: str,
        source_review_unit_id: str,
        transcript_digest: str,
        body_markdown: str,
        audit_reference: ArtifactReference,
    ) -> bool:
        value = self._request(
            "POST",
            "/v1/observations",
            {
                "observation_id": observation_id,
                "source_workflow": source_workflow,
                "source_run_id": source_run_id,
                "source_review_unit_id": source_review_unit_id,
                "transcript_digest": transcript_digest,
                "body_markdown": body_markdown,
                "audit_reference": audit_reference.as_dict(),
            },
        )
        if value.get("ok") is not True:
            raise RuntimeError("Memory catalog did not accept the observation.")
        return value.get("created") is True

    def pending_observation_summary(self) -> dict[str, Any]:
        return self._request("GET", "/v1/observations/pending-summary")

    def select_maintenance_batch(self, *, limit: int) -> dict[str, Any] | None:
        value = self._request(
            "POST",
            "/v1/maintenance/batches/select",
            {"limit": limit},
        )
        batch = value.get("batch")
        if batch is None:
            return None
        if not isinstance(batch, dict):
            raise RuntimeError("Memory catalog returned an invalid maintenance batch.")
        return dict(batch)

    def complete_maintenance(
        self,
        *,
        base_revision: int,
        observation_ids: list[str],
        memory_version: ArtifactReference,
        audit_reference: ArtifactReference,
    ) -> bool:
        value = self._request(
            "POST",
            "/v1/maintenance/complete",
            {
                "base_revision": base_revision,
                "observation_ids": observation_ids,
                "memory_version": memory_version.as_dict(),
                "audit_reference": audit_reference.as_dict(),
            },
        )
        return value.get("completed") is True

    def active_version(self) -> dict[str, Any]:
        return self._request("GET", "/v1/active-version")

    def get_revision(self, revision: int) -> dict[str, Any]:
        return self._request("GET", f"/v1/revisions/{revision}")

    def list_revisions(
        self,
        *,
        before_revision: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        parameters = [f"limit={limit}"]
        if before_revision is not None:
            parameters.append(f"before_revision={before_revision}")
        return self._request("GET", f"/v1/revisions?{'&'.join(parameters)}")


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
    "configured_memory_catalog_client",
]
