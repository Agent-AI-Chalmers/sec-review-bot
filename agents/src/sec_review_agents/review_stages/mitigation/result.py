from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.workspace.file_changes import (
    FileChange,
)


class MitigationStageResult(BaseModel):
    """A repair attempt's explanation and exported final-file changes.

    File changes are authoritative for applying and delivering the patch; the
    diff is a derived review artifact. Skipped attempts use the same result with
    empty changes and diff, while absence of a result is represented by None at
    the orchestration boundary. Retry summaries retain paths, not file contents.
    """

    overview: str
    file_changes: list[FileChange] = Field(default_factory=list)
    patch_diff: str = ""

    model_config = ConfigDict(extra="ignore")
