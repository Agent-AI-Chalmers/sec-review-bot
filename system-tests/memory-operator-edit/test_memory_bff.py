"""Operator memory edits cross the real BFF, Catalog, SQL and object store."""

import json
import tarfile
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from sec_review_agents.artifacts.materialize import materialize_verified_artifact_file
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.catalog_client import MemoryCatalogClient


def test_memory_edit_replay_and_restore(
    catalog, object_store, node_service, monkeypatch, tmp_path
):
    """A lost edit response must not create a second revision or lose its bytes."""
    for key, value in object_store.items():
        monkeypatch.setenv(key, value)
    bff = node_service(
        "memory-operator-edit/bff-server.mjs",
        {**object_store, "TEST_CATALOG_URL": catalog["url"]},
    )["url"]
    cookie = ""

    def post(path, body):
        nonlocal cookie
        request = Request(
            bff + path,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Origin": bff,
                "Cookie": cookie,
            },
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            if response.headers.get("Set-Cookie"):
                cookie = response.headers["Set-Cookie"].split(";")[0]
            body = response.read()
            # Session creation deliberately has no JSON body; edit/restore do.
            return json.loads(body) if body else None

    with pytest.raises(HTTPError) as unauthorized:
        post("/api/memory/edit", {})
    assert unauthorized.value.code == 401
    post("/api/session", {"token": "seam-ui"})
    client = MemoryCatalogClient(catalog["url"], "seam-worker")
    before = client.get_memory_tree()["revision"]
    first = {
        "operation_id": uuid.uuid4().hex,
        "expected_active_revision": before,
        "files": {"MEMORY.md": "First memory\n"},
    }
    created = post("/api/memory/edit", first)
    assert created["created"] is True
    # Replay the original operation and precondition as after a lost response.
    assert post("/api/memory/edit", first) == {**created, "created": False}
    revision = client.get_memory_tree()
    assert revision["revision"] == before + 1
    materialized = materialize_verified_artifact_file(
        ArtifactReference.from_mapping(revision["memory_tree_reference"]),
        local_destination=tmp_path / "tree.tar.zst",
        maximum_bytes=1024 * 1024,
    )
    with tarfile.open(materialized, "r:zst") as archive:
        contents = [
            archive.extractfile(member).read()
            for member in archive.getmembers()
            if member.isfile()
        ]
    assert b"First memory\n" in contents
    with pytest.raises(HTTPError) as conflict:
        post("/api/memory/edit", {**first, "operation_id": uuid.uuid4().hex})
    assert conflict.value.code == 409
    second = {
        **first,
        "operation_id": uuid.uuid4().hex,
        "expected_active_revision": before + 1,
        "files": {"MEMORY.md": "Second memory\n"},
    }
    post("/api/memory/edit", second)
    post(
        "/api/memory/restore",
        {
            "operation_id": uuid.uuid4().hex,
            "expected_active_revision": before + 2,
            "restored_revision": before + 1,
        },
    )
    assert client.get_memory_tree() == revision
