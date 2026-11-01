"""Run a bounded PatchEval queue with recorded attempts and explicit recovery."""

import argparse
import asyncio
import contextlib
import csv
import fcntl
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

from sec_review_agents.utils.env import bootstrap_agents_env

from scripts.patcheval.batch import prepare
from scripts.patcheval.cleanup import cleanup
from scripts.patcheval.experiments import EXECUTED_EXPERIMENTS
from scripts.patcheval.workspace_state import (
    dataset_cves,
    experiment_state,
    workspace_dir,
)

TERMINATION_GRACE_SECONDS = 60


@dataclass(frozen=True)
class WorkItem:
    cve: str
    variant: str
    before_status: str

    @property
    def name(self) -> str:
        return f"{self.cve}-{self.variant}"


@dataclass(frozen=True)
class Outcome:
    code: int
    interrupted: bool = False


def positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path(
            "PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json"
        ),
    )
    parser.add_argument(
        "--tag", default="DEEPSEEK-V4-PRO", help="Workspace tag (default: %(default)s)"
    )
    parser.add_argument(
        "--jobs",
        type=positive,
        default=6,
        help="Concurrent attempts, including cleanup (default: %(default)s)",
    )
    parser.add_argument(
        "--limit", type=positive, help="Run at most N queued experiments"
    )
    parser.add_argument("--variant", action="append", choices=EXECUTED_EXPERIMENTS)
    parser.add_argument(
        "--timeout-seconds",
        type=positive,
        help="Per-run timeout including materialization; disabled if omitted",
    )
    parser.add_argument(
        "--freeze-inputs",
        action="store_true",
        help="Freeze local inputs/code; existing frozen tags always enforce validation",
    )
    parser.add_argument(
        "--skip-final-verifier",
        action="store_true",
        help="Default workflows: omit verification after the last repair retry",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="CVE",
        help="Select a CVE; repeatable",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="CVE",
        help="Exclude a CVE; repeatable",
    )
    parser.add_argument(
        "--resume-incomplete",
        action="store_true",
        help="Explicitly retry existing incomplete attempts",
    )
    parser.add_argument(
        "--require-nonempty-patch",
        action="store_true",
        help="Treat empty patches as incomplete",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect queue and child commands without starting experiments",
    )
    parser.add_argument(
        "--max-failures",
        type=positive,
        help="Stop dispatch after N observed failures; in-flight tasks finish, so final failures may exceed N",
    )
    parser.add_argument(
        "--stop-on-failure",
        action="store_true",
        help="Use --max-failures 1 unless an explicit threshold is supplied",
    )
    args = parser.parse_args(argv)
    args.tag = args.tag.replace("/", "-")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.tag):
        parser.error("Invalid tag")
    args.variant = tuple(
        v for v in EXECUTED_EXPERIMENTS if not args.variant or v in args.variant
    )
    if args.skip_final_verifier and any(
        not v.endswith("-default") for v in args.variant
    ):
        parser.error("--skip-final-verifier requires selecting only default workflows")
    if args.stop_on_failure and args.max_failures is None:
        args.max_failures = 1
    return args


def select_queue(root: Path, args: argparse.Namespace) -> list[WorkItem]:
    queue = []
    complete = incomplete = blocked = 0
    for cve in dataset_cves(args.dataset):
        if (args.only and cve not in args.only) or cve in args.exclude:
            continue
        for variant in args.variant:
            status = experiment_state(
                root=root, tag=args.tag, cve=cve, experiment=variant
            ).status
            if status == "empty-patch" and not args.require_nonempty_patch:
                status = "complete"
            if status == "complete":
                complete += 1
            elif status in {"missing-workspace", "missing-symlink"}:
                queue.append(WorkItem(cve, variant, status))
            elif status.startswith("exit-") or status in {
                "missing-target",
                "missing-exit-code",
                "missing-patch",
                "empty-patch",
            }:
                if args.resume_incomplete:
                    queue.append(WorkItem(cve, variant, status))
                else:
                    incomplete += 1
                    print(f"SKIP {status}\t{cve}\t{variant}", file=sys.stderr)
            else:
                blocked += 1
                print(f"SKIP {status}\t{cve}\t{variant}", file=sys.stderr)
    print(
        f"PatchEval experiment pool\nRepo: {root}\nDataset: {args.dataset}\nTag: {args.tag}\nJobs: {args.jobs}"
    )
    print(
        f"Complete experiments: {complete}\nQueued experiments before limit: {len(queue)}\nSkipped incomplete experiments: {incomplete}\nBlocked experiments: {blocked}"
    )
    queue = queue[: args.limit]
    print(f"To run: {len(queue)}", flush=True)
    return queue


def command_for(
    item: WorkItem, root: Path, args: argparse.Namespace, batch: Path | None
) -> list[str]:
    command = [
        os.environ.get("PYTHON_BIN") or sys.executable,
        "-m",
        "scripts.patcheval.run_patcheval",
        "--cve",
        item.cve,
        "--dataset",
        str(args.dataset),
        "--output-dir",
        str(workspace_dir(root=root, tag=args.tag, cve=item.cve)),
        "--variant",
        item.variant,
    ]
    if args.skip_final_verifier:
        command.append("--skip-final-verifier")
    if batch is not None:
        command.extend(["--batch-dir", str(batch)])
    return command


def signal_group(pid: int, sig: signal.Signals) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(pid, sig)


async def wait_for_process(
    process: asyncio.subprocess.Process, stop: asyncio.Event, timeout: int | None
) -> Outcome:
    """Own the child until reaped; stop is a request, never task cancellation."""
    exited = asyncio.create_task(process.wait())
    stopping = asyncio.create_task(stop.wait())
    try:
        done, _ = await asyncio.wait(
            {exited, stopping}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        # Preserve a result already obtained when a concurrent stop arrives.
        if exited in done:
            code = exited.result()
            code = code if code >= 0 else 128 - code
            if code in {124, 137}:
                signal_group(process.pid, signal.SIGKILL)
            return Outcome(code)
        interrupted = stopping in done
        signal_group(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(asyncio.shield(exited), TERMINATION_GRACE_SECONDS)
        except TimeoutError:
            signal_group(process.pid, signal.SIGKILL)
            await exited
        # The direct child may exit before its TERM-ignoring descendants do.
        signal_group(process.pid, signal.SIGKILL)
        return Outcome(130 if interrupted else 124, interrupted)
    finally:
        stopping.cancel()
        await asyncio.gather(stopping, return_exceptions=True)
        if not exited.done():
            signal_group(process.pid, signal.SIGKILL)
            await exited


def publish_attempt(
    out: Path, logs: Path, item: WorkItem, outcome: Outcome, cleanup_code: int
) -> Outcome:
    """Publish the new link only after its logs and execution outcome are recorded."""
    stdout = logs / f"{item.name}.stdout.log"
    stderr = logs / f"{item.name}.stderr.log"
    header = logs / f"{item.name}.header.log"
    run = None
    with stdout.open(errors="replace") as stream:
        for line in stream:
            if line.startswith("LOCAL_ROOT="):
                candidate = Path(line.strip().split("=", 1)[1]).resolve()
                # Never move logs or publish a link outside this task's workspace.
                if candidate.parent == out.resolve() and candidate.is_dir():
                    run = candidate
                break
    if run is None:
        # A zero process exit without a materialized run is not a usable success.
        if outcome.code == 0:
            outcome = Outcome(1)
        with (logs / f"{item.name}.log").open("w") as combined:
            for path in (header, stderr, stdout):
                with path.open(errors="replace") as source:
                    shutil.copyfileobj(source, combined)
        for path in (header, stderr, stdout):
            path.unlink()
        (logs / f"{item.name}.exit-code").write_text(f"{outcome.code}\n")
        print(
            f"Could not resolve LOCAL_ROOT for {item.name}; logs left at {logs}",
            file=sys.stderr,
        )
    else:
        target = run / "logs"
        target.mkdir(exist_ok=True)
        stdout = stdout.replace(target / "run.stdout.log")
        stderr = stderr.replace(target / "run.stderr.log")
        with (target / "run.log").open("w") as combined:
            combined.write(
                header.read_text()
                + f"EXIT_CODE={outcome.code}\n\n===== STDERR (diagnostics) =====\n"
            )
            with stderr.open(errors="replace") as source:
                for line in source:
                    combined.write(re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line))
            combined.write("\n===== STDOUT (metadata) =====\n")
            with stdout.open(errors="replace") as source:
                for line in source:
                    if line.startswith(("LOCAL_ROOT=", "WORKFLOW_RESULT=")):
                        combined.write(line)
        header.unlink()
        (run / "experiment-name.txt").write_text(item.name + "\n")
        (run / "exit-code.txt").write_text(f"{outcome.code}\n")
        (run / "cleanup-exit-code.txt").write_text(f"{cleanup_code}\n")
        # Atomic replacement also makes concurrent read-only collection safe.
        pending_link = out / f".{item.name}.{uuid.uuid4().hex}.link"
        pending_link.symlink_to(run.name)
        pending_link.replace(out / item.name)
        (logs / f"{item.name}.pending").unlink()
    print(
        f"{'DONE ' if outcome.code == 0 else 'FAIL '} {item.name} exit={outcome.code}",
        flush=True,
    )
    return outcome


async def run_attempt(
    item: WorkItem,
    root: Path,
    args: argparse.Namespace,
    batch: Path | None,
    stop: asyncio.Event,
    manifest: TextIO,
) -> Outcome:
    out = workspace_dir(root=root, tag=args.tag, cve=item.cve)
    logs = out / "_logs"
    logs.mkdir(parents=True, exist_ok=True)
    old = list(logs.glob(f"{item.name}.*"))
    if old:
        previous = Path(tempfile.mkdtemp(prefix=f"previous-{item.name}.", dir=logs))
        for path in old:
            path.replace(previous / path.name)
    (logs / f"{item.name}.pending").touch()
    label = f"{args.tag}-{uuid.uuid4().hex}"
    command = command_for(item, root, args, batch) + ["--container-label", label]
    (logs / f"{item.name}.header.log").write_text(
        f"EXPERIMENT={item.name}\nCVE={item.cve}\nDATASET={args.dataset}\nOUT={out}\nCOMMAND={shlex.join(command)}\nCONTAINER_LABEL={label}\n\n"
    )
    print(f"START {item.name}", flush=True)
    outcome = Outcome(130, True)
    process = None
    with (logs / f"{item.name}.stdout.log").open("w") as stdout, (
        logs / f"{item.name}.stderr.log"
    ).open("w") as stderr:
        try:
            if not stop.is_set():
                # start_new_session establishes isolation before exec. A stop that
                # arrives during spawn is still observed by wait_for_process.
                process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=root,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
            csv.writer(manifest, delimiter="\t").writerow(
                [
                    datetime.now(UTC).isoformat(),
                    item.cve,
                    item.variant,
                    item.before_status,
                    process.pid if process else "",
                ]
            )
            manifest.flush()
            if process is not None:
                outcome = await wait_for_process(process, stop, args.timeout_seconds)
        except OSError as error:
            stderr.write(f"Execution failed: {error}\n")
            outcome = Outcome(127)
        finally:
            # Also cover a publication/manifest error after spawning the child.
            if process is not None and process.returncode is None:
                signal_group(process.pid, signal.SIGKILL)
                await process.wait()
    if outcome.interrupted:
        (logs / f"{item.name}.interrupted").write_text("interrupted\n")
    cleanup_code = 0
    try:
        # Docker subprocesses are synchronous and bounded inside cleanup(); do
        # not block signal handling or other attempts while waiting for Docker.
        await asyncio.to_thread(cleanup, label)
    except (OSError, subprocess.SubprocessError) as error:
        cleanup_code = 1
        print(
            f"Container cleanup failed for {label}; inspect before resuming: {error}",
            file=sys.stderr,
        )
    (logs / f"{item.name}.cleanup-exit-code").write_text(f"{cleanup_code}\n")
    return publish_attempt(out, logs, item, outcome, cleanup_code)


async def dispatch(
    queue: list[WorkItem],
    root: Path,
    args: argparse.Namespace,
    batch: Path | None,
    stop: asyncio.Event,
    manifest: TextIO,
) -> int:
    pending = set()
    remaining = iter(queue)
    exhausted = False
    failures = interrupted = 0
    threshold_reported = False
    try:
        while pending or not exhausted:
            # Reap *all* completed tasks before filling any free slot. Already
            # observed failures must affect the dispatch threshold immediately.
            for task in list(pending):
                if not task.done():
                    continue
                pending.remove(task)
                try:
                    outcome = task.result()
                except OSError as error:
                    print(f"Attempt recording failed: {error}", file=sys.stderr)
                    outcome = Outcome(1)
                interrupted += outcome.interrupted
                failures += outcome.code != 0 and not outcome.interrupted
            threshold = args.max_failures is not None and failures >= args.max_failures
            if threshold and not threshold_reported:
                print(
                    f"Failure threshold reached: {failures}/{args.max_failures}. Not launching new experiments.",
                    file=sys.stderr,
                    flush=True,
                )
                threshold_reported = True
            if stop.is_set() or threshold:
                exhausted = True
            while not exhausted and len(pending) < args.jobs:
                item = next(remaining, None)
                if item is None:
                    exhausted = True
                    break
                pending.add(
                    asyncio.create_task(
                        run_attempt(item, root, args, batch, stop, manifest)
                    )
                )
            if pending:
                await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
    finally:
        if pending:
            stop.set()
            await asyncio.gather(*pending, return_exceptions=True)
    print(
        f"Failures observed: {failures}\nInterrupted attempts: {interrupted}",
        flush=True,
    )
    return int(bool(failures or interrupted or stop.is_set()))


async def run_pool(root: Path, args: argparse.Namespace, manifests: Path) -> int:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    for sig in signals:
        loop.add_signal_handler(sig, stop.set)
    try:
        queue = select_queue(root, args)
        batch = manifests / args.tag
        frozen = (batch / "identity.json").is_file()
        if frozen or (args.freeze_inputs and queue and not args.dry_run):
            if not frozen and any(
                root.glob(f".agent-workspace-patcheval-CVE-*-{args.tag}")
            ):
                raise ValueError(
                    "Existing unmanifested runs: select a new tag for frozen experiments."
                )
            prepare(
                root,
                batch,
                args.dataset,
                args.timeout_seconds,
                args.skip_final_verifier,
                args.variant,
            )
        else:
            batch = None
        if not queue:
            print("Nothing to run.")
            return 0
        if args.dry_run:
            print("Queued commands:")
            for item in queue:
                print(
                    f"  # {item.cve} {item.variant} ({item.before_status})\n  {shlex.join(command_for(item, root, args, batch))}"
                )
            return 0
        # Let any signal received during synchronous preflight stop dispatch.
        await asyncio.sleep(0)
        with tempfile.NamedTemporaryFile(
            mode="w",
            prefix=f"experiment-pool-{args.tag}-{datetime.now(UTC):%Y%m%dT%H%M%SZ}.",
            suffix=".tsv",
            dir=manifests,
            delete=False,
        ) as manifest:
            manifest.write("timestamp\tcve\tvariant\tbefore_status\tpid\n")
            manifest.flush()
            print(f"Manifest: {manifest.name}", flush=True)
            result = await dispatch(queue, root, args, batch, stop, manifest)
            print(f"Experiment pool complete. Manifest: {manifest.name}")
            return result
    finally:
        for sig in signals:
            loop.remove_signal_handler(sig)


def main() -> None:
    args = parse_args()
    root = Path(__file__).resolve().parents[2]
    os.chdir(root)
    args.dataset = args.dataset.resolve()
    bootstrap_agents_env()
    # All PatchEval conditions are offline, even if the host .env enables bridge.
    os.environ["AGENT_DOCKER_NETWORK_MODE"] = "none"
    manifests = root / ".patcheval-batch-manifests"
    manifests.mkdir(exist_ok=True)
    # Retain the lock inode; removing it would let a second pool lock a new file.
    with (manifests / f"{args.tag}.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f"Another pool is using tag {args.tag}", file=sys.stderr)
            raise SystemExit(2) from None
        try:
            result = asyncio.run(run_pool(root, args, manifests))
        except (OSError, ValueError) as error:
            print(error, file=sys.stderr)
            result = 2
    raise SystemExit(result)


if __name__ == "__main__":
    main()
