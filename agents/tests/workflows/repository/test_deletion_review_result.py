from sec_review_agents.workflows.repository.result import (
    build_repository_workflow_result,
)
from tests.repository_scan_fixtures import scan_result_fixture


def _result(scan: dict) -> dict:
    return build_repository_workflow_result(
        scan_result=scan_result_fixture(**scan),
        delivery_result=None,
        case_results=[],
    )


def test_deleted_file_count_appears_in_the_scan_summary() -> None:
    """A deletion count belongs with the other scan counts and explains a thin run.

    Deletions never reach discovery -- there is no current content to read -- so without this
    count an incremental run that mostly removed files looks like a scan that found nothing.
    """
    result = _result({"deleted_file_count": 12, "deletion_review_skipped": False})

    assert result["scan_summary"]["deleted_file_count"] == 12
    assert result["deletion_review_skipped"] is False


def test_a_skipped_deletion_review_says_so_in_the_result() -> None:
    """A run that never reviewed its deletions must not read as an ordinary success.

    The skip is decided before any case exists, so nothing in the case pipeline carries it. It
    travels with the scan, or the gap would be visible only in an internal log.
    """
    result = _result({"deleted_file_count": 250, "deletion_review_skipped": True})

    assert result["scan_summary"]["deleted_file_count"] == 250
    assert result["deletion_review_skipped"] is True


def test_the_scan_counts_only_deletions_review_covers() -> None:
    """Ignored trees are not review targets, so they must not count toward the skip decision.

    Counting them would let a routine vendored-tree removal push a small window over the limit
    and skip deletion review for files that were never reviewable.
    """
    from sec_review_agents.workflows.repository.case_execution_input import (
        window_deletion_summary,
    )

    assert window_deletion_summary(
        scan_scope={
            "paths_ignore": ["vendor/**"],
            "incremental_changed_files": [
                {"path": "src/auth/gone.py", "status": "deleted"},
                {"path": "vendor/lib/x.py", "status": "deleted"},
                {"path": "src/kept.py", "status": "modified"},
            ],
        },
        scan_mode="incremental",
    ).model_dump() == {"deleted_file_count": 1, "deletion_review_skipped": False}


def test_a_window_past_the_limit_reports_the_skip() -> None:
    from sec_review_agents.workflows.repository.case_execution_input import (
        MAX_DELETED_FILES,
        window_deletion_summary,
    )

    summary = window_deletion_summary(
        scan_scope={
            "incremental_changed_files": [
                {"path": f"src/f{index}.py", "status": "deleted"}
                for index in range(MAX_DELETED_FILES + 1)
            ]
        },
        scan_mode="incremental",
    )

    assert summary.model_dump() == {
        "deleted_file_count": MAX_DELETED_FILES + 1,
        "deletion_review_skipped": True,
    }


def test_a_full_scan_counts_no_deletions() -> None:
    from sec_review_agents.workflows.repository.case_execution_input import (
        window_deletion_summary,
    )

    assert window_deletion_summary(
        scan_scope={"incremental_changed_files": []}, scan_mode="full"
    ).model_dump() == {"deleted_file_count": 0, "deletion_review_skipped": False}
