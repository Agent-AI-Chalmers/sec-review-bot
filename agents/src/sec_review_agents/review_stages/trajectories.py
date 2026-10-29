"""Review-stage trajectory layout."""

from pathlib import Path

from sec_review_agents.runtime import trajectories
from sec_review_agents.utils.files import slug_filename_component

TRAJECTORIES_DIRNAME = "trajectories"


def review_trajectories_root(artifact_root_path: Path) -> Path:
    return artifact_root_path / TRAJECTORIES_DIRNAME


def review_trajectory_path(
    trajectories_root: Path,
    *,
    order: int,
    stage: str,
    attempt: str = "initial",
) -> Path:
    if order < 1:
        raise ValueError("Trajectory order must be >= 1.")
    suffix = "-".join(
        (
            slug_filename_component(stage, fallback="unknown"),
            slug_filename_component(attempt, fallback="unknown"),
        )
    )
    return trajectories.trajectory_path(
        trajectories_root,
        name=f"{order:04d}-{suffix}",
    )


__all__ = [
    "TRAJECTORIES_DIRNAME",
    "review_trajectories_root",
    "review_trajectory_path",
]
