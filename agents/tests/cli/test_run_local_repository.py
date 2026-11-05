from unittest.mock import patch

from sec_review_agents.cli.run_local_repository import parse_args


def test_parse_args_collects_repeated_paths_ignore_patterns() -> None:
    with patch(
        "sys.argv",
        [
            "sec-review-agents-run-local-repository",
            "--repo",
            "/repo",
            "--output-dir",
            "/runs",
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
