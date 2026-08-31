import shutil
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


def reset_stage_attempt_artifacts(
    root: Path,
    *,
    filenames: Sequence[str] = (),
    directories: Sequence[str] = (),
) -> None:
    for filename in filenames:
        (root / filename).unlink(missing_ok=True)
    for directory in directories:
        shutil.rmtree(root / directory, ignore_errors=True)


def _copy_existing_stage_artifact(root: Path, source: str, target: str) -> None:
    source_path = root / source
    if not source_path.exists():
        return
    target_path = root / target
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, target_path)


def archive_current_feedback_attempt(
    *,
    mitigator_root: Path,
    verifier_root: Path,
    retry_context: Mapping[str, Any],
) -> None:
    retry_index = retry_context.get("retry_index")
    if retry_index != 1:
        return

    for source, target in (
        ("mitigation-result.json", "mitigation-result.initial.json"),
        ("workspace.patch", "workspace.initial.patch"),
    ):
        _copy_existing_stage_artifact(mitigator_root, source, target)

    for source, target in (
        ("verification-result.json", "verification-result.initial.json"),
    ):
        _copy_existing_stage_artifact(verifier_root, source, target)
