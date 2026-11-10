from pathlib import Path

from sec_review_agents.review_stages.trajectories import (
    review_trajectories_root,
    review_trajectory_outputs,
    review_trajectory_path,
)


def test_review_trajectories_root_uses_flat_trajectories_directory(
    tmp_path: Path,
) -> None:
    assert review_trajectories_root(tmp_path) == tmp_path / "trajectories"


def test_review_trajectory_path_numbers_stage_attempt(
    tmp_path: Path,
) -> None:
    root = review_trajectories_root(tmp_path)
    assert (
        review_trajectory_path(
            root,
            order=4,
            stage="mitigator",
            attempt="retry-1",
        )
        == tmp_path / "trajectories" / "0004-mitigator-retry-1.jsonl"
    )


def test_review_trajectory_path_accepts_an_existing_trajectories_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "case" / "trajectories"
    assert (
        review_trajectory_path(
            root,
            order=2,
            stage="verifier",
        )
        == root / "0002-verifier-initial.jsonl"
    )


def test_review_trajectory_outputs_without_publication_is_local_only(
    tmp_path: Path,
) -> None:
    local = tmp_path / "trajectory.jsonl"

    assert review_trajectory_outputs(local, None) == (local,)


def test_review_trajectory_outputs_removes_stale_published_copy(
    tmp_path: Path,
) -> None:
    """A run that fails before writing must not leave the old published file."""
    local = tmp_path / "local" / "trajectory.jsonl"
    published = tmp_path / "published.jsonl"
    published.write_text("stale\n")

    assert review_trajectory_outputs(local, published) == (local, published)
    assert not published.exists()
