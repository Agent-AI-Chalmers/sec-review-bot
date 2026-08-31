import fcntl
import hashlib
import shutil
import tempfile
from collections.abc import Iterable
from pathlib import Path

from sec_review_agents.resources.materialization import materialize_resource_tree
from sec_review_agents.resources.paths import AGENT_SKILLS

_DEFAULT_SKILLS_MATERIALIZED_ROOT: Path | None = None


def skills_materialized_base_root() -> Path:
    global _DEFAULT_SKILLS_MATERIALIZED_ROOT
    if _DEFAULT_SKILLS_MATERIALIZED_ROOT is None:
        _DEFAULT_SKILLS_MATERIALIZED_ROOT = Path(
            tempfile.mkdtemp(prefix="sec-review-agents-skills-")
        ).resolve()
    return _DEFAULT_SKILLS_MATERIALIZED_ROOT


def _normalize_component(value: str, label: str) -> str:
    normalized = value.strip().strip("/")
    if not normalized or "/" in normalized or "\\" in normalized:
        raise ValueError(f"{label} must be a non-empty path component.")
    return normalized


def _hash_resource_tree(hasher, source, prefix: str = "") -> None:
    children = sorted(source.iterdir(), key=lambda child: child.name)
    for child in children:
        child_path = f"{prefix}{child.name}"
        if child.is_dir():
            hasher.update(f"dir:{child_path}/\n".encode())
            _hash_resource_tree(hasher, child, f"{child_path}/")
        else:
            hasher.update(f"file:{child_path}\n".encode())
            hasher.update(child.read_bytes())


def _skills_view_name(skill_names: tuple[str, ...]) -> str:
    hasher = hashlib.sha256()
    for skill_name in skill_names:
        hasher.update(f"skill:{skill_name}\n".encode())
    return f"skills-{hasher.hexdigest()[:16]}"


def _skills_view_manifest(skill_names: tuple[str, ...]) -> str:
    hasher = hashlib.sha256()
    for skill_name in skill_names:
        source = AGENT_SKILLS / skill_name
        if not source.is_dir():
            raise FileNotFoundError(f"Unknown bundled agent skill: {skill_name}")
        hasher.update(f"skill:{skill_name}\n".encode())
        _hash_resource_tree(hasher, source, f"{skill_name}/")
    return hasher.hexdigest()


def _rebuild_skills_view(
    destination: Path,
    skill_names: tuple[str, ...],
) -> None:
    temp_destination = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent)
    )
    try:
        for skill_name in skill_names:
            materialize_resource_tree(
                AGENT_SKILLS / skill_name,
                temp_destination / skill_name,
            )

        if destination.exists():
            shutil.rmtree(destination)
        temp_destination.rename(destination)
    finally:
        if temp_destination.exists():
            shutil.rmtree(temp_destination)


def materialize_agent_skills_view(
    skill_names: Iterable[str],
) -> Path:
    normalized_skill_names = tuple(
        _normalize_component(skill_name, "Skill name") for skill_name in skill_names
    )
    view_name = _skills_view_name(normalized_skill_names)

    base_root = skills_materialized_base_root()
    base_root.mkdir(parents=True, exist_ok=True)
    destination = base_root / view_name
    manifest_path = base_root / f".{view_name}.manifest"
    lock_path = base_root / f".{view_name}.lock"
    expected_manifest = _skills_view_manifest(
        normalized_skill_names,
    )

    with lock_path.open("w", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        current_manifest = (
            manifest_path.read_text(encoding="utf-8").strip()
            if manifest_path.is_file()
            else None
        )
        if current_manifest != expected_manifest or not destination.is_dir():
            _rebuild_skills_view(destination, normalized_skill_names)
            manifest_path.write_text(f"{expected_manifest}\n", encoding="utf-8")

    return destination
