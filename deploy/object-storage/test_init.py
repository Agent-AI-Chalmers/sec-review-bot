import importlib.util
import json
import os
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("RUSTFS_ROOT_PASSWORD", "test-root-secret")
MODULE_PATH = Path(__file__).with_name("init.py")
SPEC = importlib.util.spec_from_file_location("object_storage_init", MODULE_PATH)
assert SPEC and SPEC.loader
storage_init = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage_init)


def test_put_user_uses_rustfs_admin_upsert() -> None:
    with patch.object(storage_init, "admin_request") as request:
        storage_init.put_user("review user", "secret")

    method, path, body = request.call_args.args
    assert method == "PUT"
    assert path == "/rustfs/admin/v3/add-user?accessKey=review+user"
    assert json.loads(body) == {"secretKey": "secret", "status": "enabled"}


def test_attach_policy_uses_rustfs_builtin_policy_api() -> None:
    with patch.object(storage_init, "admin_request") as request:
        storage_init.attach_policy("reader", "runner")

    assert request.call_args.args == (
        "POST",
        "/rustfs/admin/v3/idp/builtin/policy/attach",
        b'{"policies": ["reader"], "user": "runner"}',
    )


def test_admin_request_signs_the_payload_digest() -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self) -> bytes:
            return b""

    with patch.object(urllib.request, "urlopen", return_value=Response()) as urlopen:
        storage_init.admin_request("PUT", "/rustfs/admin/v3/example", b"payload")

    request = urlopen.call_args.args[0]
    assert request.headers["X-amz-content-sha256"] == (
        "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5"
    )
