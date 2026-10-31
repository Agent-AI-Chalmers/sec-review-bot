"""Worker-owned input after public validation and bundle materialization."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sec_review_agents.scan_stages.input import RepositoryScanScope
from sec_review_agents.workflows.review_intent import ReviewIntent


class PreparedReviewInput(BaseModel):
    """Materialized workspace references and policy shared by all review stages.

    Paths belong to the worker filesystem; caller bundle references and public
    API metadata are discarded once preparation has resolved them.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    input_bundle_root_path: Annotated[str, Field(pattern=r"\S")]
    artifact_root_path: Annotated[str, Field(pattern=r"\S")]
    workspace_snapshot_tar_path: Annotated[str, Field(pattern=r"\S")]
    history_path: Annotated[str, Field(pattern=r"\S")]
    review_intent: ReviewIntent
    setup_declaration: str | None = None


class PreparedIssueInput(PreparedReviewInput):
    """Issue metadata with analysis, mitigation, and verification artifact destinations."""

    workflow: Literal["issue-review"] = "issue-review"
    issue: dict[str, Any]
    analyzer_artifacts_path: Annotated[str, Field(pattern=r"\S")]
    mitigator_artifacts_path: Annotated[str, Field(pattern=r"\S")]
    verifier_artifacts_path: Annotated[str, Field(pattern=r"\S")]


class PreparedPullRequestInput(PreparedReviewInput):
    """PR metadata and its required incremental window, with stage artifact destinations."""

    workflow: Literal["pull-request-review"] = "pull-request-review"
    pr: dict[str, Any]
    incremental_window_path: Annotated[str, Field(pattern=r"\S")]
    analyzer_artifacts_path: Annotated[str, Field(pattern=r"\S")]
    mitigator_artifacts_path: Annotated[str, Field(pattern=r"\S")]
    verifier_artifacts_path: Annotated[str, Field(pattern=r"\S")]


class PreparedRepositoryInput(PreparedReviewInput):
    """Repository controls and discovery, triage, and case artifact destinations.

    scan_scope is the shared typed scan input; mode and revision range
    are explicit controls validated before activities or child workflows run.
    """

    workflow: Literal["repository-review"] = "repository-review"
    scan_mode: Literal["full", "incremental"]
    base_sha: str | None = None
    head_sha: str | None = None
    scan_scope: RepositoryScanScope
    incremental_window_path: str | None = None
    discovery_artifacts_path: Annotated[str, Field(pattern=r"\S")]
    triage_artifacts_path: Annotated[str, Field(pattern=r"\S")]
    cases_artifacts_path: Annotated[str, Field(pattern=r"\S")]

    @model_validator(mode="after")
    def require_incremental_range(self) -> PreparedRepositoryInput:
        if self.scan_mode == "incremental":
            if (
                not self.base_sha
                or not self.base_sha.strip()
                or not self.head_sha
                or not self.head_sha.strip()
                or not self.incremental_window_path
                or not self.incremental_window_path.strip()
            ):
                raise ValueError(
                    "incremental review requires base/head SHA and window path"
                )
            if self.base_sha.strip() == self.head_sha.strip():
                raise ValueError("incremental base SHA must differ from head SHA")
        return self


PreparedWorkflowInput = Annotated[
    PreparedIssueInput | PreparedPullRequestInput | PreparedRepositoryInput,
    Field(discriminator="workflow"),
]
