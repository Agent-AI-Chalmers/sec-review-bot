"""Memory activities use the worker environment, never a local CLI dotenv file."""

import os
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.revision_commit_input import MemoryTreeRevisionCommitInput
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionRegistrationPayload,
    MemoryExtractionRequest,
    prepare_memory_extraction_activity,
    register_memory_extraction_activity,
)
from sec_review_agents.workflows.memory.maintenance import (
    MemoryMaintenanceRequest,
    commit_memory_tree_revision_activity,
    count_pending_memory_observations_activity,
    prepare_memory_maintenance_activity,
)


@pytest.fixture
def local_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "AGENT_MEMORY_PROCESSING_ENABLED=false\n"
        "AGENT_MEMORY_CATALOG_URL=http://local-cli.invalid\n"
        "AGENT_MEMORY_CATALOG_TOKEN=local-cli-token\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "sec_review_agents.utils.package_paths.default_agents_env_path", lambda: dotenv
    )
    monkeypatch.setattr("sec_review_agents.utils.env._AGENTS_ENV_BOOTSTRAPPED", False)

    def unexpected_request(*args: object, **kwargs: object) -> None:
        pytest.fail("Activity used catalog settings from the local CLI dotenv file.")

    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client._open_catalog_request",
        unexpected_request,
    )
    with patch.dict(os.environ, {}, clear=True):
        yield


@pytest.mark.asyncio
@pytest.mark.parametrize("processing", [None, "true"])
@pytest.mark.parametrize("operation", ["extraction", "maintenance", "backlog"])
async def test_preparation_requires_worker_catalog_even_when_dotenv_provides_one(
    local_dotenv: None, processing: str | None, operation: str
) -> None:
    """A CLI file must neither disable processing nor supply missing worker credentials."""
    if processing is not None:
        os.environ["AGENT_MEMORY_PROCESSING_ENABLED"] = processing
    before = dict(os.environ)
    with pytest.raises(ValueError, match="AGENT_MEMORY_CATALOG_URL"):
        if operation == "extraction":
            await prepare_memory_extraction_activity(
                MemoryExtractionRequest(
                    source_workflow="issue-review",
                    run_id="run-1",
                    unit_id="review",
                    execution_archive={},
                    timeout_seconds=30,
                )
            )
        elif operation == "maintenance":
            await prepare_memory_maintenance_activity(
                MemoryMaintenanceRequest(timeout_seconds=30)
            )
        else:
            count_pending_memory_observations_activity()
    assert dict(os.environ) == before


@pytest.mark.parametrize("operation", ["register", "commit"])
def test_commit_requires_worker_catalog_even_when_dotenv_provides_one(
    local_dotenv: None, operation: str
) -> None:
    """Retrying a prepared write must not silently select a catalog from a local file."""
    reference = ArtifactReference(
        uri="s3://sec-review/memory/tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )
    before = dict(os.environ)
    with pytest.raises(RuntimeError, match="catalog is required"):
        if operation == "register":
            register_memory_extraction_activity(
                MemoryExtractionRegistrationPayload(
                    extraction_id="extraction-1",
                    source_workflow="issue-review",
                    source_run_id="run-1",
                    source_unit_id="review",
                    execution_archive_digest=reference.digest,
                    trajectory_reference=reference,
                    observation_markdown=None,
                    skipped=True,
                    summary="No observation.",
                    observation_produced=False,
                )
            )
        else:
            commit_memory_tree_revision_activity(
                MemoryTreeRevisionCommitInput(
                    maintenance_id="maintenance-1",
                    expected_active_revision=0,
                    extraction_ids=("extraction-1",),
                    memory_tree_reference=reference,
                    maintenance_trajectory_reference=reference,
                )
            )
    assert dict(os.environ) == before
