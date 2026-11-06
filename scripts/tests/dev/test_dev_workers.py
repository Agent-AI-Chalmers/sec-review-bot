from argparse import Namespace
from pathlib import Path
from unittest.mock import Mock

from scripts.dev import dev_workers


def test_dev_worker_environments_use_role_specific_storage_credentials(
    monkeypatch,
) -> None:
    for name, value in {
        "SEC_REVIEW_EXECUTION_S3_ACCESS_KEY": "execution-key",
        "SEC_REVIEW_EXECUTION_S3_SECRET_KEY": "execution-secret",
        "SEC_REVIEW_MEMORY_S3_ACCESS_KEY": "memory-key",
        "SEC_REVIEW_MEMORY_S3_SECRET_KEY": "memory-secret",
        "SEC_REVIEW_ARTIFACT_S3_BUCKET": "sec-review",
        "SEC_REVIEW_ARTIFACT_S3_ENDPOINT": "http://127.0.0.1:9100",
        "AGENT_MEMORY_CATALOG_URL": "http://127.0.0.1:8092",
        "AGENT_MEMORY_CATALOG_TOKEN": "catalog-token",
    }.items():
        monkeypatch.setenv(name, value)

    execution = dev_workers._dev_worker_environment(
        access_key_env="SEC_REVIEW_EXECUTION_S3_ACCESS_KEY",
        secret_key_env="SEC_REVIEW_EXECUTION_S3_SECRET_KEY",
        maintenance=False,
    )
    maintenance = dev_workers._dev_worker_environment(
        access_key_env="SEC_REVIEW_MEMORY_S3_ACCESS_KEY",
        secret_key_env="SEC_REVIEW_MEMORY_S3_SECRET_KEY",
        maintenance=True,
    )

    assert execution["AWS_ACCESS_KEY_ID"] == "execution-key"
    assert execution["AWS_SECRET_ACCESS_KEY"] == "execution-secret"
    assert maintenance["AWS_ACCESS_KEY_ID"] == "memory-key"
    assert maintenance["AWS_SECRET_ACCESS_KEY"] == "memory-secret"
    assert maintenance["TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES"] == "1"


def test_dev_workers_load_explicit_env_file(monkeypatch, tmp_path: Path) -> None:
    env_file = tmp_path / "dev_workers.env"
    env_file.write_text("AGENT_MEMORY_CATALOG_TOKEN=local-token\n", encoding="utf-8")
    monkeypatch.setenv("AGENT_MEMORY_CATALOG_TOKEN", "agents-env-token")
    monkeypatch.setattr(dev_workers, "_supervise_dev_workers", lambda: 0)

    assert dev_workers._run_dev_workers(Namespace(env_file=env_file)) == 0
    assert dev_workers.os.environ["AGENT_MEMORY_CATALOG_TOKEN"] == "local-token"


def test_dev_worker_failure_stops_remaining_workers(monkeypatch) -> None:
    for name, value in {
        "SEC_REVIEW_EXECUTION_S3_ACCESS_KEY": "execution-key",
        "SEC_REVIEW_EXECUTION_S3_SECRET_KEY": "execution-secret",
        "SEC_REVIEW_MEMORY_S3_ACCESS_KEY": "memory-key",
        "SEC_REVIEW_MEMORY_S3_SECRET_KEY": "memory-secret",
        "SEC_REVIEW_ARTIFACT_S3_BUCKET": "sec-review",
        "SEC_REVIEW_ARTIFACT_S3_ENDPOINT": "http://127.0.0.1:9100",
        "AGENT_MEMORY_CATALOG_URL": "http://127.0.0.1:8092",
        "AGENT_MEMORY_CATALOG_TOKEN": "catalog-token",
    }.items():
        monkeypatch.setenv(name, value)

    execution = Mock(pid=101)
    execution.poll.return_value = 7
    extraction = Mock(pid=102)
    extraction.poll.return_value = None
    maintenance = Mock(pid=103)
    maintenance.poll.return_value = None
    processes = iter((execution, extraction, maintenance))

    monkeypatch.setattr(dev_workers.shutil, "which", lambda command: f"/bin/{command}")
    monkeypatch.setattr(
        dev_workers.subprocess, "Popen", lambda *args, **kwargs: next(processes)
    )
    monkeypatch.setattr(
        dev_workers.signal, "signal", lambda *args: dev_workers.signal.SIG_DFL
    )

    assert dev_workers._supervise_dev_workers() == 7
    execution.terminate.assert_not_called()
    extraction.terminate.assert_called_once_with()
    maintenance.terminate.assert_called_once_with()
