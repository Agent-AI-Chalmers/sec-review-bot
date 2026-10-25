"""Materialize the active Catalog memory tree for one agent invocation."""

import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.features import memory_consumption_enabled
from sec_review_agents.filesystem.path_views import PathView, memory_view


@contextmanager
def materialized_memory_view() -> Generator[PathView | None]:
    """Yield the active memory tree for one invocation, then remove it.

    Unlike bundled skills, memory is revision-selected external input. The caller
    therefore owns its invocation-scoped lifetime and passes the resulting view
    into backend construction.
    """
    if not memory_consumption_enabled():
        yield None
        return

    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.memory_tree_artifact import materialize_memory_tree

    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        yield None
        return
    active = catalog_client.get_memory_tree()
    raw_reference = active.get("memory_tree_reference")
    if raw_reference is None:
        yield None
        return
    reference = ArtifactReference.from_mapping(raw_reference)
    if urlparse(reference.uri).scheme != "s3":
        raise ValueError("Catalog active memory must use an S3 artifact reference.")

    with tempfile.TemporaryDirectory(prefix="sec-review-runtime-memory-") as tempdir:
        content_root = materialize_memory_tree(
            reference,
            destination=Path(tempdir) / "memory-tree",
        )
        yield memory_view(host_path=content_root)


__all__ = ["materialized_memory_view"]
