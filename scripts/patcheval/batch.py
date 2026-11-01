"""Freeze a local experiment's inputs; the pool owns the per-tag lock.

Only configuration hashes are public. The model file and process environment can
contain credentials, so their snapshots stay in a private directory (never git).
"""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

from sec_review_agents.llm.config import resolve_config_toml_path
from sec_review_agents.utils.env import bool_env, bootstrap_agents_env

from scripts.patcheval.experiments import EXECUTED_EXPERIMENTS
from scripts.patcheval.workspace_state import read_dataset

FLAG_DEFAULTS = {
    "AGENT_SKILLS_ENABLED": True,
    "AGENT_MCP_ENABLED": False,
    "AGENT_JOERN_ENABLED": False,
    "AGENT_PLAYWRIGHT_ENABLED": False,
    "AGENT_MEMORY_CONSUMPTION_ENABLED": True,
    "AGENT_MEMORY_PROCESSING_ENABLED": True,
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def code_digest(root: Path) -> str:
    # Include untracked source too: a clean HEAD alone cannot identify local runs.
    hasher = hashlib.sha256()
    # Agent resources (including prompts) affect generation. Reporting tools and
    # README edits do not; keep the script execution dependencies explicit here.
    paths = [
        path
        for path in (root / "agents/src").rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    ]
    paths.extend(
        root / "scripts/patcheval" / name
        for name in (
            "__init__.py",
            "batch.py",
            "cleanup.py",
            "dataset.py",
            "experiments.py",
            "issue_bundle.py",
            "generation_image.py",
            "patch_execution.py",
            "run_patcheval.py",
            "workspace_seed.py",
            "workspace_state.py",
            "pool.py",
        )
    )
    paths.append(root / "PatchEval/patcheval/datasets/environments.json")
    paths.extend(root / name for name in ("agents/uv.lock", "agents/pyproject.toml"))
    for path in sorted(paths):
        if path.is_file():
            hasher.update(str(path.relative_to(root)).encode())
            hasher.update(b"\0")
            hasher.update(digest(path.read_bytes()).encode())
    return hasher.hexdigest()


def configuration_environment() -> dict[str, str]:
    # Preserve actual settings, including unset flags resolved to defaults. This
    # snapshot is private; diagnostics expose only its hash, never secret values.
    values = {
        key: value
        for key, value in os.environ.items()
        if key.startswith(("AGENT_", "LANGFUSE_", "AWS_", "MODEL_"))
    }
    # Benchmark sandboxes are offline for every experimental condition.
    values["AGENT_DOCKER_NETWORK_MODE"] = "none"
    for key, default in FLAG_DEFAULTS.items():
        values[key] = str(bool_env(key, default)).lower()
    if values["AGENT_MEMORY_CONSUMPTION_ENABLED"] == "true" and values.get(
        "AGENT_MEMORY_CATALOG_URL"
    ):
        raise ValueError(
            "Frozen Memory execution is not implemented in this script yet; "
            "do not treat an active Catalog pointer as a pinned snapshot"
        )
    return values


def prepare(
    root: Path,
    directory: Path,
    dataset: Path,
    timeout: int | None,
    skip_final: bool,
    variants: tuple[str, ...] = EXECUTED_EXPERIMENTS,
) -> None:
    bootstrap_agents_env()
    read_dataset(dataset)
    model = resolve_config_toml_path()
    environment = configuration_environment()
    identity = {
        "variants": sorted(set(variants)),
        "dataset_sha256": digest(dataset.read_bytes()),
        "model_sha256": digest(model.read_bytes()),
        "environment_sha256": digest(json.dumps(environment, sort_keys=True).encode()),
        "code_sha256": code_digest(root),
        "timeout_seconds": timeout,
        "skip_final_verifier": skip_final,
        "flags": {key: environment[key] for key in FLAG_DEFAULTS},
    }
    identity_path = directory / "identity.json"
    if identity_path.exists():
        previous = json.loads(identity_path.read_text())
        # Resuming a subset is safe; adding a new workflow to an existing
        # condition needs a new batch identity rather than silent expansion.
        if not set(variants).issubset(previous["variants"]):
            raise ValueError("Workflow selection is outside the frozen batch")
        identity["variants"] = previous["variants"]
        if previous != identity:
            raise ValueError(
                "Batch configuration changed; use a new tag, do not mix conditions"
            )
        return
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    for name, content in {
        "dataset.json": dataset.read_bytes(),
        "model.toml": model.read_bytes(),
        "environment.json": json.dumps(environment).encode(),
        "identity.json": json.dumps(identity, indent=2).encode(),
    }.items():
        path = directory / name
        path.write_bytes(content)
        path.chmod(0o600)
    # HEAD is useful provenance, while the content fingerprint is authoritative.
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    (directory / "commit.txt").write_text(commit.stdout)


def activate(
    directory: Path, root: Path, *, skip_final: bool, variant: str | None = None
) -> Path:
    identity = json.loads((directory / "identity.json").read_text())
    if variant is not None and variant not in identity["variants"]:
        raise ValueError("Workflow is outside the frozen batch")
    if (
        code_digest(root) != identity["code_sha256"]
        or skip_final != identity["skip_final_verifier"]
    ):
        raise ValueError("Code or execution policy changed after batch freeze")
    dataset = directory / "dataset.json"
    model = directory / "model.toml"
    for path, key in ((dataset, "dataset_sha256"), (model, "model_sha256")):
        if digest(path.read_bytes()) != identity[key]:
            raise ValueError(f"Frozen batch input changed: {path.name}")
    values = json.loads((directory / "environment.json").read_text())
    if (
        digest(json.dumps(values, sort_keys=True).encode())
        != identity["environment_sha256"]
    ):
        raise ValueError("Frozen environment changed")
    # Remove new inherited settings as well as overriding old ones. Otherwise a
    # later shell/.env could silently add a capability absent at batch creation.
    for key in list(os.environ):
        if key.startswith(("AGENT_", "LANGFUSE_", "AWS_", "MODEL_")):
            del os.environ[key]
    os.environ.update(values)
    os.environ["MODEL_PROVIDERS_CONFIG_TOML"] = str(model.resolve())
    return dataset


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int)
    parser.add_argument("--skip-final-verifier", action="store_true")
    parser.add_argument("--variant", action="append", choices=EXECUTED_EXPERIMENTS)
    args = parser.parse_args()
    prepare(
        Path.cwd(),
        args.directory,
        args.dataset,
        args.timeout_seconds,
        args.skip_final_verifier,
        tuple(args.variant or EXECUTED_EXPERIMENTS),
    )


if __name__ == "__main__":
    main()
