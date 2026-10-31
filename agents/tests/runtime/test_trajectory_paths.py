from pathlib import Path

import pytest

from sec_review_agents.review_stages.feedback_loop import (
    feedback_retry_context,
    review_stage_attempt_order,
)
from sec_review_agents.runtime.trajectories import trajectory_path


def test_trajectory_path_uses_default_filename(tmp_path: Path) -> None:
    assert trajectory_path(tmp_path) == tmp_path / "trajectory.jsonl"


@pytest.mark.parametrize("name", ["nested/trajectory", "trajectory.jsonl"])
def test_trajectory_path_rejects_physical_filename_details(
    tmp_path: Path,
    name: str,
) -> None:
    with pytest.raises(ValueError, match="plain file stem"):
        trajectory_path(tmp_path, name=name)


def test_review_stage_attempt_order_preserves_review_stage_order() -> None:
    assert review_stage_attempt_order(stage="analyzer", retry_context=None) == 1
    assert review_stage_attempt_order(stage="mitigator", retry_context=None) == 2
    assert review_stage_attempt_order(stage="verifier", retry_context=None) == 3
    assert (
        review_stage_attempt_order(
            stage="mitigator",
            retry_context=feedback_retry_context(
                retry_index=1, mitigation_result=None, verifier_result=None
            ),
        )
        == 4
    )
    assert (
        review_stage_attempt_order(
            stage="verifier",
            retry_context=feedback_retry_context(
                retry_index=1, mitigation_result=None, verifier_result=None
            ),
        )
        == 5
    )


def test_review_stage_attempt_order_rejects_unknown_stage() -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        review_stage_attempt_order(stage="cvss", retry_context=None)
