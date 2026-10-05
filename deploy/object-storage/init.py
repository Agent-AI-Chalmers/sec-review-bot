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
REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ.get("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


ROOT_ACCESS_KEY = os.environ.get("RUSTFS_ROOT_USER", "sec-review-root")
ROOT_SECRET_KEY = required_env("RUSTFS_ROOT_PASSWORD")
ROOT_CREDENTIALS = Credentials(ROOT_ACCESS_KEY, ROOT_SECRET_KEY)


def admin_request(method: str, path: str, body: bytes = b"") -> None:
    """Call RustFS's native admin namespace with the SigV4 scheme it requires."""
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
    # RustFS add-user is an upsert, so reruns also apply credential rotation.
    query = urllib.parse.urlencode({"accessKey": access_key})
    body = json.dumps({"secretKey": secret_key, "status": "enabled"}).encode()
    admin_request("PUT", f"/rustfs/admin/v3/add-user?{query}", body)


def put_policy(name: str, path: Path) -> None:
    # Replacing the named policy keeps the deployed least-privilege document authoritative.
    query = urllib.parse.urlencode({"name": name})
    admin_request(
        "PUT", f"/rustfs/admin/v3/add-canned-policy?{query}", path.read_bytes()
    )


def attach_policy(name: str, access_key: str) -> None:
    body = json.dumps({"policies": [name], "user": access_key}).encode()
    admin_request("POST", "/rustfs/admin/v3/idp/builtin/policy/attach", body)


def wait_for_rustfs() -> None:
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
    integration_access_key = os.environ.get(
        "SEC_REVIEW_INTEGRATION_S3_ACCESS_KEY", "sec-review-integration"
    )
    runner_access_key = os.environ.get(
        "SEC_REVIEW_RUNNER_S3_ACCESS_KEY", "sec-review-runner"
    )
    integration_secret_key = required_env("SEC_REVIEW_INTEGRATION_S3_SECRET_KEY")
    runner_secret_key = required_env("SEC_REVIEW_RUNNER_S3_SECRET_KEY")
    policy_root = Path("/policies")

    wait_for_rustfs()
    put_user(integration_access_key, integration_secret_key)
    put_user(runner_access_key, runner_secret_key)
    put_policy("sec-review-input-writer", policy_root / "integration-policy.json")
    put_policy("sec-review-input-reader", policy_root / "runner-policy.json")
    attach_policy("sec-review-input-writer", integration_access_key)
    attach_policy("sec-review-input-reader", runner_access_key)


if __name__ == "__main__":
    main()
