"""Disposable infrastructure for bounded, model-free cross-service probes."""

import json
import os
import subprocess
import time
import uuid

import boto3
import pytest
import yaml
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from project_paths import REPOSITORY_ROOT, SYSTEM_TESTS_ROOT


def run(*args, timeout=120, **kwargs):
    return subprocess.run(
        args, check=True, text=True, capture_output=True, timeout=timeout, **kwargs
    )


def wait_for(probe, *, process=None):
    """Retry startup races, then surface the final probe's original exception."""
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"Test service exited with {process.returncode}")
        try:
            return probe()
        except (
            OSError,
            subprocess.SubprocessError,
            json.JSONDecodeError,
            BotoCoreError,
            ClientError,
        ):
            time.sleep(0.1)
    return probe()


@pytest.fixture(scope="session")
def compose_images():
    return yaml.safe_load((REPOSITORY_ROOT / "compose.yaml").read_text())["services"]


@pytest.fixture(scope="session")
def postgres(compose_images):
    """Use a private container, never an ordinary deployment database URL."""
    name = f"seam-postgres-{uuid.uuid4().hex}"
    try:
        run(
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "-p",
            "127.0.0.1::5432",
            "-e",
            "POSTGRES_PASSWORD=seam-password",
            compose_images["postgres"]["image"],
        )
        # The image briefly starts a Unix-socket-only bootstrap server. Probe TCP
        # so readiness cannot succeed just before that bootstrap server stops.
        wait_for(
            lambda: run(
                "docker",
                "exec",
                name,
                "pg_isready",
                "-h",
                "127.0.0.1",
                "-U",
                "postgres",
            )
        )
        port = run("docker", "port", name, "5432/tcp").stdout.strip().rsplit(":", 1)[1]
        databases = {}
        # These services have independent schema-version ledgers; sharing the
        # server is cheap, but sharing a database would make test order matter.
        for database in ("catalog", "review_runs"):
            run(
                "docker",
                "exec",
                name,
                "psql",
                "-U",
                "postgres",
                "-c",
                f"CREATE DATABASE {database}",
            )
            databases[database] = (
                f"postgresql://postgres:seam-password@127.0.0.1:{port}/{database}"
            )
        yield databases
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], check=False, capture_output=True, timeout=30
        )


@pytest.fixture(scope="session")
def object_store(compose_images):
    """A private RustFS bucket serves both cross-language and BFF probes."""
    name = f"seam-storage-{uuid.uuid4().hex}"
    try:
        run(
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "-p",
            "127.0.0.1::9000",
            "-e",
            "RUSTFS_ACCESS_KEY=seam-access",
            "-e",
            "RUSTFS_SECRET_KEY=seam-secret-password",
            compose_images["rustfs"]["image"],
            "/data",
        )
        port = run("docker", "port", name, "9000/tcp").stdout.strip().rsplit(":", 1)[1]
        endpoint = f"http://127.0.0.1:{port}"
        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id="seam-access",
            aws_secret_access_key="seam-secret-password",
            region_name="us-east-1",
            config=Config(
                connect_timeout=2, read_timeout=2, retries={"max_attempts": 0}
            ),
        )
        wait_for(lambda: client.list_buckets())
        client.create_bucket(Bucket="sec-review")
        yield {
            "AWS_ACCESS_KEY_ID": "seam-access",
            "AWS_SECRET_ACCESS_KEY": "seam-secret-password",
            "AWS_REGION": "us-east-1",
            "SEC_REVIEW_ARTIFACT_STORE": "s3",
            "SEC_REVIEW_ARTIFACT_S3_BUCKET": "sec-review",
            "SEC_REVIEW_ARTIFACT_S3_ENDPOINT": endpoint,
            "SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE": "path",
        }
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], check=False, capture_output=True, timeout=30
        )


@pytest.fixture
def node_service(tmp_path):
    """Start production Node services with a ready-file handshake and bounded cleanup."""
    processes = []

    def start(script, env):
        ready = tmp_path / f"ready-{len(processes)}.json"
        log = (tmp_path / f"node-{len(processes)}.log").open("w+")
        process = subprocess.Popen(
            ["node", str(SYSTEM_TESTS_ROOT / script)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, **env, "NODE_ENV": "test", "READY_FILE": str(ready)},
            stdout=log,
            stderr=log,
        )
        processes.append((process, log))
        try:
            return wait_for(lambda: json.loads(ready.read_text()), process=process)
        except (OSError, RuntimeError, json.JSONDecodeError) as error:
            log.seek(0)
            pytest.fail(f"{error}\n{log.read()}")

    yield start
    # Stop dependents first: a BFF started after Catalog must close before it.
    for process, log in reversed(processes):
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log.close()


@pytest.fixture
def catalog(postgres, node_service):
    return node_service(
        "memory-catalog/catalog-server.mjs", {"TEST_DATABASE_URL": postgres["catalog"]}
    )


@pytest.fixture(scope="session")
def temporal(compose_images):
    """Start Temporal only for tests requesting the lifecycle fixture."""
    name = f"seam-temporal-{uuid.uuid4().hex}"
    try:
        run(
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "-p",
            "127.0.0.1::7233",
            compose_images["temporal"]["image"],
            "server",
            "start-dev",
            "--ip",
            "0.0.0.0",
        )
        wait_for(
            lambda: run(
                "docker",
                "exec",
                name,
                "temporal",
                "operator",
                "cluster",
                "health",
                "--address",
                "127.0.0.1:7233",
            )
        )
        port = run("docker", "port", name, "7233/tcp").stdout.strip().rsplit(":", 1)[1]
        yield f"127.0.0.1:{port}"
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], check=False, capture_output=True, timeout=30
        )
