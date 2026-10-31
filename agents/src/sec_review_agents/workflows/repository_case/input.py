"""Prepared input consumed by repository-case execution, independent of triage."""

from typing import NotRequired, TypedDict

from sec_review_agents.workflows.review_intent import TestChangesPolicy


class RepositoryCaseExecutionInput(TypedDict):
    case_id: str
    review_input: str
    workspace_snapshot_tar_path: str
    history_path: str
    scan_mode: str
    incremental_window_path: str | None
    test_changes: TestChangesPolicy
    setup_declaration_content: NotRequired[str | None]


class RepositoryCaseArtifactPaths(TypedDict):
    analyzer: str
    cvss: str
    mitigator: str
    verifier: str


class PreparedRepositoryCase(TypedDict):
    case_execution_input: RepositoryCaseExecutionInput
    artifact_paths: RepositoryCaseArtifactPaths
    published_trajectories_path: str
