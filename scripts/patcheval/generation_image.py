"""Prepare an offline generation image without top-level evaluation materials."""

import hashlib
import json
import shlex
import uuid
from pathlib import Path, PurePosixPath

from sec_review_agents.utils.env import env_value

from scripts.patcheval.dataset import PatchevalCase
from scripts.patcheval.workspace_seed import (
    PatchevalWorkspaceSeedError,
    _run_docker_command,
)

ENVIRONMENTS_PATH = (
    Path(__file__).resolve().parents[2]
    / "PatchEval/patcheval/datasets/environments.json"
)


def validate_work_dir(value: str) -> str:
    path = PurePosixPath(value)
    if (
        str(path) != value
        or path.parent != PurePosixPath("/workspace")
        or path.name in {"PoC_env", ".", ".."}
        or any(char in value for char in ("\n", "\r", "\x00", ","))
    ):
        raise ValueError("PatchEval work_dir must be a direct project under /workspace")
    return path.name


def prepare_generation_image(case: PatchevalCase) -> dict:
    project = validate_work_dir(case.work_dir)
    # Resolve locally before Docker create so a missing benchmark image never
    # triggers a pull. Pin extraction and generation to this exact image ID.
    inspected = json.loads(
        _run_docker_command(["image", "inspect", case.image_name]).stdout
    )[0]
    source_id = inspected["Id"]
    # The full dataset was checked offline once. Normal runs consume the fixed
    # per-case settings, without rediscovering runtimes or checking dependencies.
    configured = json.loads(ENVIRONMENTS_PATH.read_text())[case.cve_id]
    if (
        configured["source_image"] != source_id
        or configured["work_dir"] != case.work_dir
    ):
        raise ValueError(
            f"Image or project path differs from the configured environment: {case.cve_id}"
        )
    environment = configured["environment"]
    siblings = configured["preserved_workspace_siblings"]
    # Keep dependency siblings while removing the image's source and top-level
    # evaluation materials; the independent working copy is mounted afterwards.
    allowed = "|".join(shlex.quote(name) for name in [project, *siblings])
    preserved = "|".join(shlex.quote(name) for name in siblings) or "__none__"
    command = f"""set -eu
for item in /workspace/* /workspace/.[!.]* /workspace/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    name=${{item##*/}}
    if [ -d "$item" ]; then
        case "$name" in {allowed}) ;; *) echo "Unclassified workspace directory: $name" >&2; exit 42;; esac
    fi
done
"""
    command += f"""for item in /workspace/* /workspace/.[!.]* /workspace/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    case "${{item##*/}}" in {preserved}) ;; *) rm -rf -- "$item";; esac
done
mkdir -p {shlex.quote(case.work_dir)}
"""
    name = f"patcheval-generation-{uuid.uuid4().hex[:12]}"
    created = False
    try:
        # No inherited ENTRYPOINT, no API credentials, no volumes, no network.
        labels = []
        if cleanup_label := env_value("AGENT_DOCKER_RUN_LABEL"):
            labels = ["--label", f"sec-review.run={cleanup_label}"]
        _run_docker_command(
            [
                "create",
                "--name",
                name,
                *labels,
                "--network",
                "none",
                "--user",
                "0",
                "--entrypoint",
                "",
                source_id,
                "/bin/sh",
                "-c",
                command,
            ]
        )
        created = True
        _run_docker_command(["start", "--attach", name])
        status = json.loads(_run_docker_command(["inspect", name]).stdout)[0]["State"]
        if status["ExitCode"] != 0:
            raise PatchevalWorkspaceSeedError(
                f"Generation image preparation failed: {status['ExitCode']}"
            )
        # Image ENV applies in every fresh stage and every docker exec; a one-off
        # `source activate` would be lost at the next shell invocation.
        changes = ["--change", "ENTRYPOINT []", "--change", 'CMD ["/bin/sh"]']
        for key, value in environment.items():
            # subprocess passes this entire ENV instruction as one argument.
            if any(char in value for char in ("\n", "\r", "\x00")):
                raise ValueError(f"Invalid image environment value for {key}")
            changes.extend(["--change", f"ENV {key}={value}"])
        fingerprint = hashlib.sha256(
            (source_id + command + json.dumps(environment)).encode()
        ).hexdigest()[:24]
        tag = f"sec-review-patcheval-generation:{fingerprint}"
        image_id = _run_docker_command(["commit", *changes, name, tag]).stdout.strip()
        return {
            "source_image": source_id,
            "generation_image": image_id,
            "generation_tag": tag,
            "work_dir": case.work_dir,
            "environment": environment,
            "python_runtime": configured.get("python_runtime"),
            "preserved_workspace_siblings": siblings,
            "removed_workspace_entries": configured["removed_workspace_entries"],
        }
    finally:
        if created:
            _run_docker_command(["rm", "-f", name])
