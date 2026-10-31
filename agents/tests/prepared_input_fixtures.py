"""Complete runtime inputs for tests that exercise individual workflow stages."""

from typing import Any

from sec_review_agents.workflows.prepared_input import (
    PreparedIssueInput,
    PreparedPullRequestInput,
    PreparedRepositoryInput,
)
from sec_review_agents.workflows.review_intent import ReviewIntent


def prepared_issue_input(**fields: Any) -> PreparedIssueInput:
    return PreparedIssueInput(
        **{
            "input_bundle_root_path": "/tmp/input-bundle",
            "artifact_root_path": "/tmp/artifacts",
            "workspace_snapshot_tar_path": "/tmp/input-bundle/workspace.snapshot.tar",
            "history_path": "/tmp/input-bundle/history",
            "review_intent": ReviewIntent(objective="audit", test_changes="allow"),
            "issue": {},
            "analyzer_artifacts_path": "/tmp/artifacts/analyzer",
            "mitigator_artifacts_path": "/tmp/artifacts/mitigator",
            "verifier_artifacts_path": "/tmp/artifacts/verifier",
            **fields,
        }
    )


def prepared_pull_request_input(**fields: Any) -> PreparedPullRequestInput:
    return PreparedPullRequestInput(
        **{
            "input_bundle_root_path": "/tmp/input-bundle",
            "artifact_root_path": "/tmp/artifacts",
            "workspace_snapshot_tar_path": "/tmp/input-bundle/workspace.snapshot.tar",
            "history_path": "/tmp/input-bundle/history",
            "incremental_window_path": "/tmp/input-bundle/incremental-window.json",
            "review_intent": ReviewIntent(objective="audit", test_changes="allow"),
            "pr": {},
            "analyzer_artifacts_path": "/tmp/artifacts/analyzer",
            "mitigator_artifacts_path": "/tmp/artifacts/mitigator",
            "verifier_artifacts_path": "/tmp/artifacts/verifier",
            **fields,
        }
    )


def prepared_repository_input(**fields: Any) -> PreparedRepositoryInput:
    return PreparedRepositoryInput(
        **{
            "input_bundle_root_path": "/tmp/input-bundle",
            "artifact_root_path": "/tmp/artifacts",
            "workspace_snapshot_tar_path": "/tmp/input-bundle/workspace.snapshot.tar",
            "history_path": "/tmp/input-bundle/history",
            "review_intent": ReviewIntent(objective="audit", test_changes="allow"),
            "scan_mode": "full",
            "scan_scope": {"paths_ignore": [], "incremental_changed_files": []},
            "discovery_artifacts_path": "/tmp/artifacts/discovery",
            "triage_artifacts_path": "/tmp/artifacts/triage",
            "cases_artifacts_path": "/tmp/artifacts/cases",
            **fields,
        }
    )
