import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from scripts.replay.input_bundle import read_json
from sec_review_agents.llm.config import resolve_config_toml_path
from sec_review_agents.utils.env import bootstrap_agents_env

DEFAULT_EXPERIMENTS = (
    "batch-pro:batched:deepseek_v4_pro",
    "batch-flash:batched:deepseek_v4_flash",
    "single-flash:single:deepseek_v4_flash",
    "single-pro:single:deepseek_v4_pro",
)


@dataclass(frozen=True)
class Experiment:
    name: str
    triage_mode: str
    deployment: str


def _parse_experiment(value: str) -> Experiment:
    parts = [part.strip() for part in str(value or "").split(":")]
    if len(parts) != 3 or not all(parts):
        raise ValueError(
            "--experiment must use '<name>:<single|batched>:<deployment>', "
            f"got: {value!r}"
        )
    name, triage_mode, deployment = parts
    if triage_mode not in {"single", "batched"}:
        raise ValueError(f"Invalid triage mode in --experiment: {triage_mode}")
    return Experiment(name=name, triage_mode=triage_mode, deployment=deployment)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run a repository triage experiment matrix. Each experiment rewrites only "
            "the temporary model config, replays triage, captures output, and renames "
            "triage to triage-<name>."
        )
    )
    parser.add_argument(
        "--run-artifacts-path",
        required=True,
        help="Path to artifacts/run-... directory.",
    )
    parser.add_argument(
        "--input-path",
        help=(
            "Optional repository-review-input.json path. Defaults to "
            "<workspace-root>/repository-review-input.json."
        ),
    )
    parser.add_argument(
        "--discovery-path",
        help=(
            "Optional discovery-result.json path. Defaults to "
            "<run-artifacts>/discovery/discovery-result.json."
        ),
    )
    parser.add_argument(
        "--experiment",
        action="append",
        default=[],
        help=(
            "Experiment spec '<name>:<single|batched>:<deployment>'. May be repeated. "
            f"Default matrix: {', '.join(DEFAULT_EXPERIMENTS)}."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=30,
        help="Batch size for batched experiments. Default: 30.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Delete existing triage-<name> directories before running.",
    )
    return parser.parse_args()


def _resolve_input_path(run_artifacts: Path, input_path: str | None) -> Path:
    if input_path:
        return Path(input_path).expanduser().resolve()
    return run_artifacts.parent.parent / "repository-review-input.json"


def _resolve_discovery_path(run_artifacts: Path, discovery_path: str | None) -> Path:
    if discovery_path:
        return Path(discovery_path).expanduser().resolve()
    return run_artifacts / "discovery" / "discovery-result.json"


def _triager_config_text(source: Path, deployment: str) -> str:
    text = source.read_text(encoding="utf-8")
    marker = re.search(r"(?m)^\[agent_deployment_bindings\]\s*$", text)
    if marker is None:
        raise ValueError(f"Missing [agent_deployment_bindings] in {source}")

    head = text[: marker.end()]
    body = text[marker.end() :]
    next_section = re.search(r"(?m)^\[", body)
    if next_section:
        agent_body = body[: next_section.start()]
        tail = body[next_section.start() :]
    else:
        agent_body = body
        tail = ""

    pattern = re.compile(r'(?m)^(repository-triager\s*=\s*)".*?"')
    replacement = rf'\1"{deployment}"'
    if pattern.search(agent_body):
        agent_body = pattern.sub(replacement, agent_body, count=1)
    else:
        agent_body = agent_body.rstrip() + f'\nrepository-triager = "{deployment}"\n'
    return head + agent_body + tail


def _write_experiment_model_config(
    *, source_config: Path, deployment: str, tempdir: Path
) -> Path:
    target = tempdir / f"model-providers-triage-{deployment}.toml"
    target.write_text(
        _triager_config_text(source_config, deployment),
        encoding="utf-8",
    )
    return target


def _prepare_live_triage_dir(*, run_artifacts: Path) -> Path:
    live_dir = run_artifacts / "triage"
    if live_dir.exists():
        shutil.rmtree(live_dir)
    live_dir.mkdir(parents=True, exist_ok=True)
    return live_dir


def _run_one(
    *,
    run_artifacts: Path,
    input_path: Path,
    discovery_path: Path,
    experiment: Experiment,
    batch_size: int,
    overwrite: bool,
    source_model_config: Path,
    tempdir: Path,
) -> dict:
    destination = run_artifacts / f"triage-{experiment.name}"
    if destination.exists():
        if not overwrite:
            raise FileExistsError(
                f"Experiment destination already exists: {destination}. "
                "Pass --overwrite to replace it."
            )
        shutil.rmtree(destination)

    live_dir = _prepare_live_triage_dir(run_artifacts=run_artifacts)
    model_config = _write_experiment_model_config(
        source_config=source_model_config,
        deployment=experiment.deployment,
        tempdir=tempdir,
    )

    cmd = [
        sys.executable,
        "-m",
        "scripts.replay.repository_triage",
        "--run-artifacts-path",
        str(run_artifacts),
        "--input-path",
        str(input_path),
        "--discovery-path",
        str(discovery_path),
        "--triage-mode",
        experiment.triage_mode,
        "--batch-size",
        str(batch_size),
    ]
    env = dict(os.environ)
    env["MODEL_PROVIDERS_CONFIG_TOML"] = str(model_config)

    completed = subprocess.run(
        cmd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

    output_text = "$ " + " ".join(cmd) + "\n" + completed.stdout
    (live_dir / "output").write_text(output_text, encoding="utf-8")

    if completed.returncode != 0:
        failed_destination = run_artifacts / f"triage-{experiment.name}-failed"
        if failed_destination.exists():
            shutil.rmtree(failed_destination)
        live_dir.rename(failed_destination)
        raise RuntimeError(
            f"Experiment {experiment.name} failed with exit code "
            f"{completed.returncode}; artifacts moved to {failed_destination}"
        )

    live_dir.rename(destination)
    summary = _experiment_summary(destination)
    summary.update(
        {
            "name": experiment.name,
            "triage_mode": experiment.triage_mode,
            "deployment": experiment.deployment,
            "path": str(destination),
        }
    )
    return summary


def _experiment_summary(path: Path) -> dict:
    result_path = path / "triage-result.json"
    result = read_json(result_path)
    token_usage = _aggregate_token_usage(path)
    counts = result.get("counts") or {}
    metadata = result.get("metadata") or {}
    return {
        "ok": result.get("status") == "completed",
        "input_candidate_count": counts.get("input_candidate_count"),
        "case_count": counts.get("case_count"),
        "suppressed_candidate_count": counts.get("suppressed_candidate_count"),
        "triage_pass_count": metadata.get("triage_pass_count"),
        "total_tokens": token_usage.get("total_tokens"),
        "input_tokens": token_usage.get("input_tokens"),
        "output_tokens": token_usage.get("output_tokens"),
        "ai_message_count": token_usage.get("ai_message_count"),
    }


def _aggregate_token_usage(path: Path) -> dict:
    latest_paths = sorted(path.rglob("token-usage.json"))
    latest_dirs = {token_path.parent for token_path in latest_paths}
    attempt_paths = [
        token_path
        for token_path in sorted(path.rglob("token-usage.*.json"))
        if token_path.parent not in latest_dirs
    ]
    payloads = [read_json(token_path) for token_path in [*latest_paths, *attempt_paths]]
    if not payloads:
        return {}
    return {
        "total_tokens": sum(int(item.get("total_tokens", 0) or 0) for item in payloads),
        "input_tokens": sum(int(item.get("input_tokens", 0) or 0) for item in payloads),
        "output_tokens": sum(
            int(item.get("output_tokens", 0) or 0) for item in payloads
        ),
        "ai_message_count": sum(
            int(item.get("ai_message_count", 0) or 0) for item in payloads
        ),
    }


def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    run_artifacts = Path(args.run_artifacts_path).expanduser().resolve()
    input_path = _resolve_input_path(run_artifacts, args.input_path)
    discovery_path = _resolve_discovery_path(run_artifacts, args.discovery_path)
    source_model_config = resolve_config_toml_path()

    if not run_artifacts.exists():
        raise FileNotFoundError(f"Run artifacts path does not exist: {run_artifacts}")
    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")
    if not discovery_path.exists():
        raise FileNotFoundError(f"Discovery JSON does not exist: {discovery_path}")

    experiments = [
        _parse_experiment(value)
        for value in (args.experiment or list(DEFAULT_EXPERIMENTS))
    ]

    summaries: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="triage-experiments-") as temp:
        tempdir = Path(temp)
        for experiment in experiments:
            print(
                f"== running {experiment.name} "
                f"({experiment.triage_mode}, {experiment.deployment}) ==",
                flush=True,
            )
            summaries.append(
                _run_one(
                    run_artifacts=run_artifacts,
                    input_path=input_path,
                    discovery_path=discovery_path,
                    experiment=experiment,
                    batch_size=args.batch_size,
                    overwrite=args.overwrite,
                    source_model_config=source_model_config,
                    tempdir=tempdir,
                )
            )

    print(
        json.dumps({"ok": True, "experiments": summaries}, ensure_ascii=False, indent=2)
    )


if __name__ == "__main__":
    main()
