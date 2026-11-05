import pytest

from sec_review_agents.cli.run_local_issue import parse_args as parse_issue
from sec_review_agents.cli.run_local_pr import parse_args as parse_pr
from sec_review_agents.cli.run_local_repository import parse_args as parse_repository


@pytest.mark.parametrize(
    "parse_args,extra",
    [
        (parse_issue, ["--review-objective", "repair"]),
        (parse_pr, ["--base-sha", "base", "--head-sha", "head"]),
        (parse_repository, []),
    ],
)
def test_local_cli_requires_explicit_output_location(
    parse_args, extra, monkeypatch
) -> None:
    monkeypatch.setattr("sys.argv", ["local-run", "--repo", "/repo", *extra])
    with pytest.raises(SystemExit) as error:
        parse_args()
    assert error.value.code == 2


@pytest.mark.parametrize(
    "parse_args,extra",
    [
        (parse_issue, ["--review-objective", "repair"]),
        (parse_pr, ["--base-sha", "base", "--head-sha", "head"]),
        (parse_repository, []),
    ],
)
def test_local_cli_accepts_output_parent(
    parse_args, extra, monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        "sys.argv",
        ["local-run", "--repo", "/repo", *extra, "--output-dir", str(tmp_path)],
    )
    assert parse_args().output_dir == str(tmp_path)
