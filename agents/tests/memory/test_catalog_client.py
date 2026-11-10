from typing import Literal
from unittest.mock import patch

import pytest

from sec_review_agents.memory.catalog_client import MemoryCatalogClient


@pytest.mark.parametrize(
    ("kind", "expected_path"),
    [
        ("learning", "/v1/memory-tree/revisions/publications/learning/m-1"),
        ("reorganization", "/v1/memory-tree/revisions/publications/reorganization/m-1"),
    ],
)
def test_list_revision_publications_selects_source_kind_path(
    kind: Literal["learning", "reorganization"], expected_path: str
) -> None:
    client = MemoryCatalogClient(base_url="http://catalog", token="token")
    with patch.object(
        MemoryCatalogClient, "_request", return_value={"publications": []}
    ) as request:
        assert client.list_revision_publications("m-1", kind=kind) == []
    request.assert_called_once_with("GET", expected_path)
