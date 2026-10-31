"""Prepared input consumed by repository-case execution, independent of triage."""

from typing import Literal

from pydantic import BaseModel, field_validator

from sec_review_agents.workflows.review_intent import TestChangesPolicy


class RepositoryCaseExecutionInput(BaseModel):
    """Prepared review brief and workspace references consumed by one case.

    Repository orchestration translates triage or deletion cases into review_input;
    case stages never need those source-specific fields. Required text must carry
    content, while optional blank paths and setup text mean absence. Preserve
    nonblank content verbatim so validation does not rewrite prompts or paths.
    """

    case_id: str
    review_input: str
    workspace_snapshot_tar_path: str
    history_path: str
    scan_mode: Literal["full", "incremental"]
    incremental_window_path: str | None
    test_changes: TestChangesPolicy
    setup_declaration_content: str | None = None

    @field_validator(
        "case_id", "review_input", "workspace_snapshot_tar_path", "history_path"
    )
    @classmethod
    def require_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("case execution input requires nonblank text")
        return value

    @field_validator("incremental_window_path", "setup_declaration_content")
    @classmethod
    def blank_means_absent(cls, value: str | None) -> str | None:
        return value if value is not None and value.strip() else None


class RepositoryCaseArtifactPaths(BaseModel):
    """Case-local artifact roots for the four review stages.

    These paths are derived once from the case root during preparation and
    carried to activities; stages do not reconstruct each other's directories.
    """

    analyzer: str
    cvss: str
    mitigator: str
    verifier: str


class PreparedRepositoryCase(BaseModel):
    """Validated execution input with the artifact locations needed by stages.

    Preparation adds worker paths without embedding request scheduling or
    runtime settings. The same value is used by direct and Temporal execution.
    """

    case_execution_input: RepositoryCaseExecutionInput
    artifact_paths: RepositoryCaseArtifactPaths
    published_trajectories_path: str
