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


def review_trajectory_outputs(
    local_path: Path, published_path: Path | None
) -> tuple[Path, ...]:
    """Return a stage run's local and optional published trajectory outputs.

    The writer truncates its outputs only once it starts. Remove the previous
    published copy first so a run that fails before then does not leave the
    previous attempt's trajectory under this run's published name.
    """
    if published_path is None:
        return (local_path,)
    published_path.unlink(missing_ok=True)
    return (local_path, published_path)


__all__ = [
    "TRAJECTORIES_DIRNAME",
    "review_trajectories_root",
    "review_trajectory_outputs",
    "review_trajectory_path",
]
