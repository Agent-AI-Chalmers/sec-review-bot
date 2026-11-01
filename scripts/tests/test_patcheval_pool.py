import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


@pytest.fixture
def pool(tmp_path: Path):
    source = Path(__file__).resolve().parents[1] / "patcheval"
    target = tmp_path / "scripts" / "patcheval"
    target.mkdir(parents=True)
    for name in (
        "pool.py",
        "workspace_state.py",
        "experiments.py",
        "batch.py",
        "cleanup.py",
        "__init__.py",
    ):
        shutil.copy(source / name, target / name)
    model = tmp_path / "model.toml"
    model.write_text("# fixture model configuration\n")
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps([{"cve_id": "CVE-2024-1234"}]))
    python = tmp_path / "fake-python"
    python.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib, sys, time\n"
        "if sys.argv[1:3] != ['-m', 'scripts.patcheval.run_patcheval']:\n"
        "    os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n"
        "if os.environ.get('PROBE_SLEEP'):\n"
        "    time.sleep(5)\n"
        "out = pathlib.Path(sys.argv[sys.argv.index('--output-dir') + 1])\n"
        "run = out / ('local-run-' + str(time.time_ns()))\n"
        "patch = run / 'artifacts' / 'mitigator' / 'workspace.patch'\n"
        "patch.parent.mkdir(parents=True)\n"
        "patch.write_text('')\n"
        "print('LOCAL_ROOT=' + str(run))\n"
    )
    python.chmod(0o755)
    docker = tmp_path / "fake-docker"
    docker.write_text("#!/bin/sh\nexit 0\n")
    docker.chmod(0o755)

    processes = []

    def invoke(*args, start=False, grace=None, **env):
        options = {
            "args": [
                sys.executable,
                "-c",
                "from scripts.patcheval import pool; "
                + (
                    f"pool.TERMINATION_GRACE_SECONDS={grace}; "
                    if grace is not None
                    else ""
                )
                + "pool.main()",
                "--dataset",
                str(dataset),
                "--tag",
                "TEST",
                *args,
            ],
            "cwd": tmp_path,
            "env": {
                **os.environ,
                "PYTHON_BIN": str(python),
                "AGENT_DOCKER_BIN": str(docker),
                "MODEL_PROVIDERS_CONFIG_TOML": str(model),
                "AGENT_MEMORY_CONSUMPTION_ENABLED": "false",
                **env,
            },
            "text": True,
        }
        if start:
            process = subprocess.Popen(
                **options,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            processes.append(process)
            return process
        return subprocess.run(**options, check=False, capture_output=True, timeout=15)

    yield tmp_path, invoke
    for process in processes:
        if process.poll() is None:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)


def test_variant_filter_and_empty_patch_resume(pool):
    root, invoke = pool
    args = ("--variant", "end-to-end-default")
    dry = invoke(*args, "--dry-run")
    assert dry.returncode == 0, dry.stderr
    assert "To run: 1" in dry.stdout
    assert "location-oracle" not in dry.stdout
    run = invoke(*args)
    assert run.returncode == 0, run.stderr
    resumed = invoke(*args, "--dry-run")
    assert "To run: 0" in resumed.stdout
    assert len(list(root.glob(".agent-workspace-*/local-run-*"))) == 1


def test_invalid_variant_rejected(pool):
    _, invoke = pool
    result = invoke("--variant", "C0", "--dry-run")
    assert result.returncode == 2
    assert "invalid choice" in result.stderr


def test_timeout_before_materialization_requires_explicit_resume(pool):
    """An attempt with no LOCAL_ROOT must not be silently retried next launch."""
    root, invoke = pool
    args = ("--variant", "end-to-end-default")
    result = invoke(*args, "--timeout-seconds", "1", PROBE_SLEEP="1")
    assert result.returncode == 1, result.stderr
    skipped = invoke(*args, "--timeout-seconds", "1", "--dry-run")
    assert "exit-124" in skipped.stderr
    assert "To run: 0" in skipped.stdout
    assert (
        "To run: 1"
        in invoke(
            *args, "--timeout-seconds", "1", "--resume-incomplete", "--dry-run"
        ).stdout
    )
    retry = invoke(*args, "--timeout-seconds", "1", "--resume-incomplete")
    assert retry.returncode == 0, retry.stderr
    assert list(root.glob(".agent-workspace-*/_logs/previous-*/*.exit-code"))


def test_interrupted_attempt_without_symlink_is_not_new(pool):
    root, invoke = pool
    logs = root / ".agent-workspace-patcheval-CVE-2024-1234-TEST" / "_logs"
    logs.mkdir(parents=True)
    (logs / "CVE-2024-1234-end-to-end-default.stdout.log").write_text("partial")
    result = invoke("--variant", "end-to-end-default", "--dry-run")
    assert "To run: 0" in result.stdout
    assert "missing-exit-code" in result.stderr


def test_default_matrix_and_repeated_selection(pool):
    _, invoke = pool
    assert "To run: 6" in invoke("--dry-run").stdout
    selected = invoke(
        "--variant",
        "end-to-end-default",
        "--variant",
        "end-to-end-single-agent",
        "--dry-run",
    )
    assert selected.returncode == 0
    assert "To run: 2" in selected.stdout


def test_failure_threshold_stops_new_dispatch(pool):
    _, invoke = pool
    result = invoke(
        "--jobs",
        "1",
        "--timeout-seconds",
        "1",
        "--stop-on-failure",
        PROBE_SLEEP="1",
    )
    assert result.returncode == 1
    assert result.stdout.count("START ") == 1
    assert "Failure threshold reached" in result.stderr


def test_pool_rejects_changed_model_on_resume(pool):
    root, invoke = pool
    assert invoke("--freeze-inputs", "--variant", "end-to-end-default").returncode == 0
    (root / "model.toml").write_text("changed")
    result = invoke("--variant", "end-to-end-default", "--dry-run")
    assert result.returncode == 2
    assert "configuration changed" in result.stderr


def test_same_tag_lock_prevents_duplicate_dispatch(pool):
    import fcntl

    root, invoke = pool
    directory = root / ".patcheval-batch-manifests"
    directory.mkdir()
    with (directory / "TEST.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = invoke("--dry-run")
    assert result.returncode == 2
    assert "Another pool" in result.stderr
    assert not list(root.glob(".agent-workspace-*"))


def test_all_fast_failures_are_reaped(pool):
    root, invoke = pool
    fake = root / "fake-python"
    script = fake.read_text().replace(
        "if os.environ.get('PROBE_SLEEP'):",
        "if os.environ.get('PROBE_FAIL'):\n    sys.exit(23)\nif os.environ.get('PROBE_SLEEP'):",
    )
    fake.write_text(script)
    result = invoke("--jobs", "6", PROBE_FAIL="1")
    assert result.returncode == 1
    assert "Failures observed: 6" in result.stdout
    assert result.stdout.count("START ") == 6


def test_failed_retry_does_not_reuse_successful_patch(pool):
    """An explicit retry of an empty patch must supersede its successful old link."""
    from scripts.patcheval.collect_patcheval_patches import collect

    root, invoke = pool
    args = ("--variant", "end-to-end-default")
    assert invoke(*args).returncode == 0
    fake = root / "fake-python"
    fake.write_text(
        fake.read_text().replace(
            "out = pathlib.Path", "sys.exit(23)\nout = pathlib.Path"
        )
    )
    retry = invoke(*args, "--require-nonempty-patch", "--resume-incomplete")
    assert retry.returncode == 1, retry.stderr
    assert collect(root, "TEST") == []
    status = invoke(*args, "--dry-run")
    assert "exit-23" in status.stderr
    assert "To run: 0" in status.stdout
    assert len(list(root.glob(".agent-workspace-*/local-run-*"))) == 1


def test_cleanup_failure_preserves_success(pool):
    root, invoke = pool
    (root / "fake-docker").write_text("#!/bin/sh\nexit 7\n")
    result = invoke("--variant", "end-to-end-default")
    assert result.returncode == 0, result.stderr
    assert "Container cleanup failed" in result.stderr
    run = next(root.glob(".agent-workspace-*/local-run-*"))
    assert (run / "exit-code.txt").read_text().strip() == "0"
    assert (run / "cleanup-exit-code.txt").read_text().strip() != "0"
    assert "To run: 0" in invoke("--dry-run", "--variant", "end-to-end-default").stdout


def test_memory_runtime_allowed_without_freeze(pool):
    root, invoke = pool
    result = invoke(
        "--variant",
        "end-to-end-default",
        AGENT_MEMORY_CONSUMPTION_ENABLED="true",
        AGENT_MEMORY_CATALOG_URL="http://catalog.invalid",
    )
    assert result.returncode == 0, result.stderr
    assert not (root / ".patcheval-batch-manifests/TEST/identity.json").exists()


def test_frozen_memory_is_rejected_before_dispatch(pool):
    _, invoke = pool
    result = invoke(
        "--freeze-inputs",
        "--variant",
        "end-to-end-default",
        AGENT_MEMORY_CONSUMPTION_ENABLED="true",
        AGENT_MEMORY_CATALOG_URL="http://catalog.invalid",
    )
    assert result.returncode == 2
    assert "Frozen Memory" in result.stderr
    assert "START " not in result.stdout


def wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Timed out waiting for subprocess observation")


def install_probe(root, body):
    """Replace only the expensive agent entrypoint; run the real Python supervisor."""
    fake = root / "fake-python"
    prefix = fake.read_text().split("if os.environ.get('PROBE_SLEEP'):")[0]
    fake.write_text(prefix + body)


def test_concurrency_limit_and_refill(pool):
    root, invoke = pool
    install_probe(
        root,
        """
import fcntl, json
state = pathlib.Path('concurrency.json')
with open('probe.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    data = json.loads(state.read_text()) if state.exists() else dict(active=0, peak=0, finished=0)
    data['active'] += 1
    data['peak'] = max(data['peak'], data['active'])
    state.write_text(json.dumps(data))
time.sleep(0.5)
with open('probe.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    data = json.loads(state.read_text())
    data['active'] -= 1
    data['finished'] += 1
    state.write_text(json.dumps(data))
sys.exit(23)
""",
    )
    result = invoke("--jobs", "2")
    assert result.returncode == 1
    assert json.loads((root / "concurrency.json").read_text()) == {
        "active": 0,
        "peak": 2,
        "finished": 6,
    }
    assert "Failures observed: 6" in result.stdout


def test_failure_threshold_allows_inflight_completion(pool):
    root, invoke = pool
    install_probe(
        root,
        """
variant = sys.argv[sys.argv.index('--variant') + 1]
pathlib.Path(variant + '.started').touch()
if variant == 'end-to-end-default':
    while len(list(pathlib.Path('.').glob('*.started'))) < 2:
        time.sleep(0.02)
    sys.exit(23)
time.sleep(1)
pathlib.Path('inflight-finished').touch()
sys.exit(24)
""",
    )
    result = invoke("--jobs", "2", "--max-failures", "1")
    assert result.returncode == 1
    assert (root / "inflight-finished").exists()
    assert len(list(root.glob("*.started"))) == 2
    assert "Failures observed: 2" in result.stdout
    assert "Interrupted attempts: 0" in result.stdout


@pytest.mark.parametrize("stop_signal", [signal.SIGTERM, signal.SIGINT, signal.SIGHUP])
def test_stop_reaps_worker_and_descendant(pool, stop_signal):
    root, invoke = pool
    install_probe(
        root,
        """
import signal, subprocess
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
def stop(signum, frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child.wait(timeout=5)
    pathlib.Path('child-reaped').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
pathlib.Path('worker-pid').write_text(str(os.getpid()))
while True:
    time.sleep(1)
""",
    )
    process = invoke("--jobs", "1", start=True)
    wait_for(lambda: (root / "worker-pid").exists())
    worker = int((root / "worker-pid").read_text())
    process.send_signal(stop_signal)
    stdout, stderr = process.communicate(timeout=10)
    assert process.returncode == 1, stderr
    assert (root / "child-reaped").exists()
    with pytest.raises(ProcessLookupError):
        os.kill(worker, 0)
    assert stdout.count("START ") == 1
    assert "Interrupted attempts: 1" in stdout
    code = next(root.glob(".agent-workspace-*/_logs/*.exit-code"))
    assert code.read_text().strip() == "130"


@pytest.mark.asyncio
@pytest.mark.parametrize("during_spawn", [False, True])
async def test_stop_at_spawn_boundary(pool, monkeypatch, during_spawn):
    """A stop before spawn prevents execution; a stop during spawn reaps the child."""
    import asyncio
    import io

    from scripts.patcheval import pool as runner

    root, _ = pool
    install_probe(root, "time.sleep(30)\n")
    monkeypatch.setenv("PYTHON_BIN", str(root / "fake-python"))
    monkeypatch.setattr(runner, "cleanup", lambda label: None)
    args = runner.parse_args(["--tag", "TEST", "--dataset", str(root / "dataset.json")])
    stop = asyncio.Event()
    spawned = []
    spawn = asyncio.create_subprocess_exec

    async def stopping_spawn(*args, **kwargs):
        process = await spawn(*args, **kwargs)
        spawned.append(process)
        stop.set()
        return process

    monkeypatch.setattr(runner.asyncio, "create_subprocess_exec", stopping_spawn)
    if not during_spawn:
        stop.set()
    outcome = await runner.run_attempt(
        runner.WorkItem("CVE-2024-1234", "end-to-end-default", "missing-workspace"),
        root,
        args,
        None,
        stop,
        io.StringIO(),
    )
    assert outcome == runner.Outcome(130, True)
    assert len(spawned) == int(during_spawn)
    for process in spawned:
        assert process.returncode is not None
        with pytest.raises(ProcessLookupError):
            os.kill(process.pid, 0)
    assert (
        next(root.glob(".agent-workspace-*/_logs/*.exit-code")).read_text().strip()
        == "130"
    )


def test_uncooperative_worker_is_killed_after_grace(pool):
    root, invoke = pool
    install_probe(
        root,
        """
import signal
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path('worker-pid').write_text(str(os.getpid()))
while True:
    time.sleep(1)
""",
    )
    # Exercise Python's real process-group escalation with a shorter test grace.
    process = invoke("--jobs", "1", start=True, grace=1)
    wait_for(lambda: (root / "worker-pid").exists())
    worker = int((root / "worker-pid").read_text())
    process.terminate()
    # Repeated stops must neither abandon wait nor restart the escalation timer.
    time.sleep(0.1)
    process.terminate()
    stdout, stderr = process.communicate(timeout=8)
    assert process.returncode == 1, stderr
    assert "Interrupted attempts: 1" in stdout
    assert stdout.count("START ") == 1
    proc = Path(f"/proc/{worker}/stat")
    assert not proc.exists() or proc.read_text().split(")", 1)[1].strip().startswith(
        "Z"
    )
    assert (
        next(root.glob(".agent-workspace-*/_logs/*.exit-code")).read_text().strip()
        == "130"
    )


def test_stop_removes_descendant_after_worker_exits(pool):
    """Reap descendants even when the direct child exits before the grace expires."""
    root, invoke = pool
    install_probe(
        root,
        """
import signal, subprocess
child = subprocess.Popen([sys.executable, '-c', "import os, pathlib, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path('descendant-pid').write_text(str(os.getpid())); time.sleep(30)"])
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while not pathlib.Path('descendant-pid').exists():
    time.sleep(0.02)
pathlib.Path('worker-ready').touch()
while True:
    time.sleep(1)
""",
    )
    process = invoke("--jobs", "1", start=True)
    wait_for(lambda: (root / "worker-ready").exists())
    descendant = int((root / "descendant-pid").read_text())
    process.terminate()
    stdout, stderr = process.communicate(timeout=8)
    assert process.returncode == 1, stderr
    assert "Interrupted attempts: 1" in stdout
    proc = Path(f"/proc/{descendant}/stat")
    assert not proc.exists() or proc.read_text().split(")", 1)[1].strip().startswith(
        "Z"
    )


def test_zero_exit_without_workspace_is_failure(pool):
    root, invoke = pool
    install_probe(root, "sys.exit(0)\n")
    result = invoke("--jobs", "1", "--stop-on-failure")
    assert result.returncode == 1
    assert result.stdout.count("START ") == 1
    assert "Failures observed: 1" in result.stdout
    assert (
        next(root.glob(".agent-workspace-*/_logs/*.exit-code")).read_text().strip()
        == "1"
    )


def test_spawn_error_is_recorded_and_stops_dispatch(pool):
    root, invoke = pool
    result = invoke(
        "--jobs", "1", "--stop-on-failure", PYTHON_BIN=str(root / "missing-python")
    )
    assert result.returncode == 1
    assert result.stdout.count("START ") == 1
    assert (
        next(root.glob(".agent-workspace-*/_logs/*.exit-code")).read_text().strip()
        == "127"
    )


def test_docker_cleanup_does_not_block_stop_of_other_attempt(pool):
    root, invoke = pool
    install_probe(
        root,
        """
import signal
variant = sys.argv[sys.argv.index('--variant') + 1]
if variant == 'end-to-end-default':
    while not pathlib.Path('worker-ready').exists():
        time.sleep(0.02)
    sys.exit(23)
def stop(*_):
    pathlib.Path('worker-stopped').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
pathlib.Path('worker-ready').touch()
while True:
    time.sleep(1)
""",
    )
    (root / "fake-docker").write_text(
        f"#!{sys.executable}\nimport pathlib, time\n"
        "pathlib.Path('cleanup-started').touch()\n"
        "time.sleep(2)\n"
        "pathlib.Path('cleanup-finished').touch()\n"
    )
    process = invoke("--jobs", "2", start=True)
    wait_for(lambda: (root / "cleanup-started").exists())
    process.terminate()
    wait_for(lambda: (root / "worker-stopped").exists(), timeout=1)
    assert not (root / "cleanup-finished").exists()
    stdout, stderr = process.communicate(timeout=8)
    assert process.returncode == 1, stderr
    assert stdout.count("START ") == 2
    assert "Failures observed: 1" in stdout
    assert "Interrupted attempts: 1" in stdout


def test_pool_overrides_inherited_network_setting(pool):
    root, invoke = pool
    fake = root / "fake-python"
    fake.write_text(
        fake.read_text().replace(
            "out = pathlib.Path",
            "assert os.environ['AGENT_DOCKER_NETWORK_MODE'] == 'none'\nout = pathlib.Path",
        )
    )
    result = invoke(
        "--variant", "end-to-end-default", AGENT_DOCKER_NETWORK_MODE="bridge"
    )
    assert result.returncode == 0, result.stderr
