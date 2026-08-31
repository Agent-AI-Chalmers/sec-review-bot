from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.workspace.file_changes import FileChange

# Stage result payload


class MitigationStageResult(BaseModel):
    overview: str
    changed_files: list[str] = Field(default_factory=list)
    file_changes: list[FileChange] = Field(default_factory=list)
    patch_diff: str = ""

    model_config = ConfigDict(extra="ignore")


def build_mitigation_stage_result(
    *,
    overview: str,
    changed_files: list[str],
    file_changes: list[FileChange] | None = None,
    patch_diff: str = "",
) -> dict[str, Any]:
    return MitigationStageResult.model_validate(
        {
            "overview": overview,
            "changed_files": changed_files,
            "file_changes": file_changes or [],
            "patch_diff": patch_diff,
        }
    ).model_dump(mode="json")


def build_skipped_mitigation_result(*, reason: str) -> dict[str, Any]:
    return build_mitigation_stage_result(
        overview=reason,
        changed_files=[],
    )
