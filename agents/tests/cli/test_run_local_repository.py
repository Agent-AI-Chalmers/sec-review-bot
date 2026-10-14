from unittest.mock import patch

import pytest

from sec_review_agents.cli.run_local_repository import parse_args


def test_parse_args_collects_repeated_paths_ignore_patterns() -> None:
    with patch(
        "sys.argv",
        [
            "sec-review-agents-run-local-repository",
            "--repo",
            "/repo",
            "--test-changes",
            "deny",
            "--paths-ignore",
            "docs",
            "--paths-ignore",
            "**/*.generated.py",
        ],
    ):
        args = parse_args()

    assert args.paths_ignore == ["docs", "**/*.generated.py"]


@pytest.mark.parametrize("removed_option", ["--repo-full-name", "--event-type"])
def test_parse_args_rejects_removed_local_metadata_options(
    removed_option: str,
) -> None:
    """Repository-local identity and event type are fixed by materialization."""
    with (
        patch(
            "sys.argv",
            [
                "sec-review-agents-run-local-repository",
                "--repo",
                "/repo",
                "--test-changes",
                "deny",
                removed_option,
                "unused",
            ],
        ),
        pytest.raises(SystemExit),
    ):
        parse_args()
