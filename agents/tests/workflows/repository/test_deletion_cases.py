from sec_review_agents.workflows.repository.case_execution_input import (
    DELETION_CASE_ORIGIN,
    MAX_DELETED_FILES,
    build_review_input,
    deleted_repository_cases,
)


def _scope(*statuses: tuple[str, str]) -> dict:
    return {
        "incremental_changed_files": [
            {"path": path, "status": status, "previous_path": None}
            for path, status in statuses
        ]
    }


def test_only_deleted_files_become_deletion_cases() -> None:
    """The case exists for what a single-file scan cannot reach.

    A modified file still has current content, so discovery can produce a candidate for it. Only a
    deleted file has none, and admitting the others here would duplicate the ordinary path.
    """
    cases = deleted_repository_cases(
        scan_scope=_scope(
            ("a/deleted.py", "deleted"),
            ("b/modified.py", "modified"),
            ("c/added.py", "added"),
        ),
        base_sha="base",
        head_sha="head",
    )

    assert len(cases) == 1
    assert cases[0]["deleted_paths"] == ["a/deleted.py"]
    assert cases[0]["origin"] == DELETION_CASE_ORIGIN
    assert cases[0]["category"] == "deleted-file"


def test_deletion_cases_honour_paths_ignore() -> None:
    """Ignored trees stay out of review, and a bulk deletion there cannot fail the run.

    Deleting a vendored tree is a routine change. Without the ignore rules, those paths would be
    analysed and could also push the deletion count past its bound, failing a legitimate window.
    """
    cases = deleted_repository_cases(
        scan_scope={
            "paths_ignore": ["vendor/**", "node_modules"],
            "incremental_changed_files": [
                {"path": "src/auth.py", "status": "deleted", "previous_path": None},
                {"path": "vendor/lib/x.py", "status": "deleted", "previous_path": None},
                {
                    "path": "node_modules/y.js",
                    "status": "deleted",
                    "previous_path": None,
                },
            ],
        },
        base_sha="base",
        head_sha="head",
    )

    assert [case["deleted_paths"] for case in cases] == [["src/auth.py"]]


def test_no_deleted_files_produce_no_case() -> None:
    cases = deleted_repository_cases(
        scan_scope=_scope(("a/modified.py", "modified")),
        base_sha="base",
        head_sha="head",
    )

    assert cases == []


def test_deleted_files_group_by_nearest_parent_directory() -> None:
    """A directory is the repository's own boundary, so it can carry a case.

    Files removed from one directory usually belong to one mechanism, and analysing them apart
    makes the analyzer re-read the same callers per file. Grouping by an invented count instead
    would merge unrelated removals and split related ones with no evidence either way.
    """
    cases = deleted_repository_cases(
        scan_scope=_scope(
            ("src/auth/middleware.py", "deleted"),
            ("src/auth/policy.py", "deleted"),
            ("src/tls/root-ca.pem", "deleted"),
            ("setup.py", "deleted"),
        ),
        base_sha="base",
        head_sha="head",
    )

    grouped = {
        case["deleted_paths"][0].rsplit("/", 1)[0]: case["deleted_paths"]
        for case in cases
    }
    assert grouped == {
        "setup.py": ["setup.py"],
        "src/auth": ["src/auth/middleware.py", "src/auth/policy.py"],
        "src/tls": ["src/tls/root-ca.pem"],
    }
    assert all(case["case_id"].startswith("deletion-") for case in cases)


def test_case_ids_stay_unique_for_directories_that_print_alike() -> None:
    """A readable substitution alone collides: "/" and ":" are both legal in a Unix path.

    Two different directories could print the same id, and the run-level uniqueness check would
    then reject a legitimate window. The digest is what keeps the id injective.
    """
    cases = deleted_repository_cases(
        scan_scope=_scope(
            ("src/a.b/gone.py", "deleted"),
            ("src/arootb/gone.py", "deleted"),
        ),
        base_sha="base",
        head_sha="head",
    )

    assert len({case["case_id"] for case in cases}) == 2


def test_too_many_deleted_files_produce_no_cases_at_all() -> None:
    """A bulk removal is not reviewed piecemeal.

    The window itself is over the limit, so no directory inside it is reviewed either: splitting
    would make the result look reviewed. That the window was skipped is reported by the scan
    (skipped_deletions_for_window), which owns the fact because the window size decided it.
    """
    cases = deleted_repository_cases(
        scan_scope=_scope(
            *[
                (f"src/auth/f{index:03d}.py", "deleted")
                for index in range(MAX_DELETED_FILES + 1)
            ]
        ),
        base_sha="base",
        head_sha="head",
    )

    assert cases == []


def test_a_window_under_the_limit_still_produces_cases() -> None:
    cases = deleted_repository_cases(
        scan_scope=_scope(("src/auth/gone.py", "deleted")),
        base_sha="base",
        head_sha="head",
    )

    assert len(cases) == 1


def test_deletion_review_input_sends_the_analyzer_to_both_sources() -> None:
    """The deleted content is not in the workspace, so the case must not pretend to quote it.

    It names the paths and offers the two places that hold the content: the materialized patch,
    and git in the workspace. No anchor is claimed, because none can be verified.
    """
    cases = deleted_repository_cases(
        scan_scope=_scope(("src/guards/auth.py", "deleted")),
        base_sha="abc123",
        head_sha="def456",
    )
    case = cases[0]

    review_input = build_review_input(case=case, scan_mode="incremental")

    assert "src/guards/auth.py" in review_input
    assert "/incremental-window/incremental.patch" in review_input
    assert "/workspace" in review_input
    assert "abc123" in review_input and "def456" in review_input
    assert "Candidate Anchors" not in review_input
    assert "reject the case" in review_input


def test_deletion_review_input_names_the_shapes_worth_investigating() -> None:
    """The case carries its own framing, since no candidate prompt points at it.

    Deletion cases never pass through discovery or triage, so this text is the only guidance the
    analyzer gets about why the case exists and what to look for. Without it the case reads as an
    empty lead about a file that cannot be opened.
    """
    cases = deleted_repository_cases(
        scan_scope=_scope(
            ("src/middleware/auth.py", "deleted"),
            ("src/policy/denylist.txt", "deleted"),
        ),
        base_sha="abc123",
        head_sha="def456",
    )
    case = cases[0]

    review_input = build_review_input(case=case, scan_mode="incremental")

    assert "Why This Case Exists" in review_input
    assert "middleware" in review_input
    assert "call sites" in review_input
    assert "denylist" in review_input
    assert "still relies on it" in review_input
