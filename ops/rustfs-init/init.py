"""Converge a fresh RustFS instance to the storage boundary used by this project.

This module runs once as the Compose ``rustfs-init`` service. It creates the
fixed ``sec-review`` bucket, upserts three runtime identities, installs their
least-privilege policies from ``/policies``, and attaches one policy to each
identity. It is intentionally deployment code rather than an application
storage client: normal services never receive the root credentials used here.

The resulting ownership model is:

* GitHub integration can read and write immutable input bundles.
* The execution worker can only read input bundles.
* Runner Service can read and write terminal result artifacts.

All provisioning operations are safe to repeat. Rerunning the container also
rotates configured user secrets and replaces policy documents with the checked-in
versions. RustFS exposes IAM management through its native admin API, so those
requests are signed explicitly below; ordinary bucket creation uses the S3 API.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from hashlib import sha256
from pathlib import Path

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.credentials import Credentials
from botocore.exceptions import ClientError

ENDPOINT = os.environ.get("RUSTFS_ENDPOINT", "http://rustfs:9000").rstrip("/")
ADMIN_API_PREFIX = "/rustfs/admin/v3"
REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = "sec-review"


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


ROOT_ACCESS_KEY = os.environ.get("RUSTFS_ROOT_USER", "sec-review-root")
ROOT_SECRET_KEY = required_env("RUSTFS_ROOT_PASSWORD")
ROOT_CREDENTIALS = Credentials(ROOT_ACCESS_KEY, ROOT_SECRET_KEY)


def admin_request(method: str, route: str, body: bytes = b"") -> None:
    """Call RustFS's native admin namespace with the SigV4 scheme it requires."""
    path = f"{ADMIN_API_PREFIX}/{route.lstrip('/')}"
    url = f"{ENDPOINT}{path}"
    # RustFS admin authentication requires the payload digest to be signed even
    # for an empty body; generic botocore AWSRequest does not add it for us.
    headers = {"x-amz-content-sha256": sha256(body).hexdigest()}
    if body:
        headers["Content-Type"] = "application/json"
    request = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(ROOT_CREDENTIALS, "s3", REGION).add_auth(request)
    prepared = request.prepare()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                url, data=body or None, headers=dict(prepared.headers), method=method
            ),
            timeout=10,
        ) as response:
            response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"RustFS admin request {method} {path} failed: {error.code} {detail}"
        ) from error


def ensure_bucket() -> None:
    """Create the fixed project bucket if RustFS reports that it is absent."""
    client = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        region_name=REGION,
        aws_access_key_id=ROOT_ACCESS_KEY,
        aws_secret_access_key=ROOT_SECRET_KEY,
        config=Config(s3={"addressing_style": "path"}),
    )
    try:
        client.head_bucket(Bucket=BUCKET)
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        # AccessDenied is not evidence that the bucket is absent.
        if status != 404:
            raise
        client.create_bucket(Bucket=BUCKET)


def put_user(access_key: str, secret_key: str) -> None:
    """Upsert an enabled RustFS identity, applying secret rotation on reruns."""
    query = urllib.parse.urlencode({"accessKey": access_key})
    body = json.dumps({"secretKey": secret_key, "status": "enabled"}).encode()
    admin_request("PUT", f"add-user?{query}", body)


def put_policy(name: str, path: Path) -> None:
    """Replace a named RustFS policy with its checked-in JSON document."""
    query = urllib.parse.urlencode({"name": name})
    admin_request("PUT", f"add-canned-policy?{query}", path.read_bytes())


def attach_policy(name: str, access_key: str) -> None:
    """Make one named policy authoritative for a provisioned identity."""
    body = json.dumps({"policies": [name], "user": access_key}).encode()
    admin_request("POST", "idp/builtin/policy/attach", body)


def wait_for_rustfs() -> None:
    """Wait up to one minute for the S3 plane and ensure the bucket exists."""

    # Compose only guarantees process start; IAM initialization must wait for the S3 plane.
    deadline = time.monotonic() + 60
    while True:
        try:
            ensure_bucket()
            return
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def main() -> None:
    """Provision the three runtime identities and their disjoint object prefixes."""

    integration_access_key = os.environ.get(
        "SEC_REVIEW_INTEGRATION_S3_ACCESS_KEY", "sec-review-integration"
    )
    runner_access_key = os.environ.get(
        "SEC_REVIEW_RUNNER_S3_ACCESS_KEY", "sec-review-runner"
    )
    integration_secret_key = required_env("SEC_REVIEW_INTEGRATION_S3_SECRET_KEY")
    runner_secret_key = required_env("SEC_REVIEW_RUNNER_S3_SECRET_KEY")
    publisher_access_key = os.environ.get(
        "SEC_REVIEW_ARTIFACT_PUBLISHER_S3_ACCESS_KEY",
        "sec-review-artifact-publisher",
    )
    publisher_secret_key = required_env("SEC_REVIEW_ARTIFACT_PUBLISHER_S3_SECRET_KEY")
    policy_root = Path("/policies")

    wait_for_rustfs()
    put_user(integration_access_key, integration_secret_key)
    put_user(runner_access_key, runner_secret_key)
    put_user(publisher_access_key, publisher_secret_key)
    put_policy("sec-review-input-writer", policy_root / "integration-policy.json")
    put_policy("sec-review-input-reader", policy_root / "runner-policy.json")
    put_policy("sec-review-artifact-publisher", policy_root / "artifact-policy.json")
    attach_policy("sec-review-input-writer", integration_access_key)
    attach_policy("sec-review-input-reader", runner_access_key)
    attach_policy("sec-review-artifact-publisher", publisher_access_key)


if __name__ == "__main__":
    main()
